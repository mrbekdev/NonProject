import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCashierReportDto } from './dto/create-cashier-report.dto';
import { UpdateCashierReportDto } from './dto/update-cashier-report.dto';

@Injectable()
export class CashierReportService {
  constructor(private prisma: PrismaService) {}

  async create(createCashierReportDto: CreateCashierReportDto) {
    return this.prisma.cashierReport.create({
      data: createCashierReportDto,
      include: {
        cashier: true,
        branch: true,
      },
    });
  }

  async findAll(query: any = {}) {
    const { cashierId, branchId, startDate, endDate, limit = 100 } = query;
    
    const where: any = {};
    
    if (cashierId) {
      where.cashierId = parseInt(cashierId);
    }
    
    if (branchId) {
      where.branchId = parseInt(branchId);
    }
    
    if (startDate || endDate) {
      where.reportDate = {};
      if (startDate) {
        where.reportDate.gte = new Date(startDate);
      }
      if (endDate) {
        where.reportDate.lte = new Date(endDate);
      }
    }

    return this.prisma.cashierReport.findMany({
      where,
      include: {
        cashier: true,
        branch: true,
      },
      orderBy: {
        reportDate: 'desc',
      },
      take: limit === 'all' ? undefined : parseInt(limit),
    });
  }

  async findOne(id: number) {
    return this.prisma.cashierReport.findUnique({
      where: { id },
      include: {
        cashier: true,
        branch: true,
      },
    });
  }

  async update(id: number, updateCashierReportDto: UpdateCashierReportDto) {
    return this.prisma.cashierReport.update({
      where: { id },
      data: updateCashierReportDto,
      include: {
        cashier: true,
        branch: true,
      },
    });
  }

  async remove(id: number) {
    return this.prisma.cashierReport.delete({
      where: { id },
    });
  }

  async getCashierReport(cashierId: number, branchId: number, startDate: Date, endDate: Date) {
    // Try to find existing report
    let report = await this.prisma.cashierReport.findUnique({
      where: {
        cashierId_branchId_reportDate: {
          cashierId,
          branchId,
          reportDate: startDate,
        },
      },
    });

    if (!report) {
      // Generate new report
      report = await this.generateCashierReport(cashierId, branchId, startDate, endDate);
    }

    return report;
  }

  private async generateCashierReport(cashierId: number, branchId: number, startDate: Date, endDate: Date) {
    // Get all transactions for the cashier in the date range
    const transactions = await this.prisma.transaction.findMany({
      where: {
        soldByUserId: cashierId,
        fromBranchId: branchId,
        type: 'SALE',
        createdAt: {
          gte: startDate,
          lte: endDate,
        },
      },
      include: {
        items: true,
        customer: true,
        paymentSchedules: true,
        payments: true,
      },
    });

    // Get daily repayments
    const dailyRepayments = await this.prisma.dailyRepayment.findMany({
      where: {
        paidByUserId: cashierId,
        transaction: {
          fromBranchId: branchId,
        },
        paidAt: {
          gte: startDate,
          lte: endDate,
        },
      },
    });

    // Get credit repayments
    const creditRepayments = await this.prisma.creditRepayment.findMany({
      where: {
        paidByUserId: cashierId,
        transaction: {
          fromBranchId: branchId,
        },
        paidAt: {
          gte: startDate,
          lte: endDate,
        },
      },
    });

    // Get defective logs
    const defectiveLogs = await this.prisma.defectiveLog.findMany({
      where: {
        userId: cashierId,
        branchId,
        createdAt: {
          gte: startDate,
          lte: endDate,
        },
      },
    });

    // Calculate totals
    let cashTotal = 0;
    let cardTotal = 0;
    let creditTotal = 0;
    let installmentTotal = 0;
    let upfrontTotal = 0;
    let upfrontCash = 0;
    let upfrontCard = 0;
    let soldQuantity = 0;
    let soldAmount = 0;
    let repaymentTotal = 0;
    let defectivePlus = 0;
    let defectiveMinus = 0;

    // Process transactions
    for (const transaction of transactions as any[]) {
      const finalTotal = Number(transaction.finalTotal || transaction.total || 0);
      const amountPaid = Number(transaction.amountPaid || 0);
      const downPayment = Number(transaction.downPayment || 0);
      const upfront = ['CREDIT', 'INSTALLMENT'].includes(transaction.paymentType || '') ? amountPaid : 0;

      const paymentsArr = Array.isArray(transaction.payments) ? transaction.payments : [];
      const hasSplitPayments = paymentsArr.length > 0;

      if (hasSplitPayments) {
        // Use split payments for simple sales
        for (const p of paymentsArr) {
          const amt = Number(p.amount || 0);
          if (!amt || Number.isNaN(amt)) continue;
          const m = String(p.method || '').toUpperCase();
          if (m === 'CASH') cashTotal += amt;
          else if (m === 'CARD') cardTotal += amt;
          else if (m === 'TERMINAL') {
            // Terminal payments should go to non-cash (account) bucket
            // In aggregated cashier report we don't have a separate field,
            // so we treat them as card-equivalent, same as elsewhere.
            cardTotal += amt;
          }
        }
      } else {
        switch (transaction.paymentType || '') {
          case 'CASH':
            cashTotal += finalTotal;
            break;
          case 'CARD':
            cardTotal += finalTotal;
            break;
          case 'CREDIT':
            creditTotal += finalTotal;
            upfrontTotal += upfront;
            if (transaction.upfrontPaymentType === 'CASH') {
              upfrontCash += upfront;
            } else if (transaction.upfrontPaymentType === 'CARD' || transaction.upfrontPaymentType === 'TERMINAL') {
              // TERMINAL upfront payments are accounted as card
              upfrontCard += upfront;
            }
            break;
          case 'INSTALLMENT':
            installmentTotal += finalTotal;
            upfrontTotal += upfront;
            if (transaction.upfrontPaymentType === 'CASH') {
              upfrontCash += upfront;
            } else if (transaction.upfrontPaymentType === 'CARD' || transaction.upfrontPaymentType === 'TERMINAL') {
              // TERMINAL upfront payments are accounted as card
              upfrontCard += upfront;
            }
            break;
        }
      }

      // Calculate sold quantity and amount
      for (const item of transaction.items) {
        soldQuantity += Number(item.quantity || 0);
        soldAmount += Number(item.total || 0);
      }
    }

    // Process daily repayments
    for (const repayment of dailyRepayments) {
      repaymentTotal += Number(repayment.amount || 0);
    }

    // Process credit repayments
    for (const repayment of creditRepayments) {
      repaymentTotal += Number(repayment.amount || 0);
    }

    // Process defective logs
    for (const log of defectiveLogs) {
      const amount = Number(log.cashAmount || 0);
      if (amount > 0) {
        defectivePlus += amount;
      } else if (amount < 0) {
        defectiveMinus += Math.abs(amount);
      }
    }

    // Create or update report
    const reportData = {
      cashierId,
      branchId,
      reportDate: startDate,
      cashTotal,
      cardTotal,
      creditTotal,
      installmentTotal,
      upfrontTotal,
      upfrontCash,
      upfrontCard,
      soldQuantity,
      soldAmount,
      repaymentTotal,
      defectivePlus,
      defectiveMinus,
    };

    return this.prisma.cashierReport.upsert({
      where: {
        cashierId_branchId_reportDate: {
          cashierId,
          branchId,
          reportDate: startDate,
        },
      },
      update: reportData,
      create: reportData,
      include: {
        cashier: true,
        branch: true,
      },
    });
  }
}
