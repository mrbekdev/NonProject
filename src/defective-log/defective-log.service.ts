import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateDefectiveLogDto } from './dto/create-defective-log.dto';
import { UpdateDefectiveLogDto } from './dto/update-defective-log.dto';
import { ProductStatus } from '@prisma/client';

@Injectable()
export class DefectiveLogService {
  constructor(private prisma: PrismaService) {}

  // Helper method to recalculate payment schedules for a transaction
  private async recalculatePaymentSchedules(transactionId: number) {
    const transaction = await this.prisma.transaction.findUnique({
      where: { id: transactionId },
      include: { 
        items: true,
        paymentSchedules: true
      }
    });

    if (!transaction || (transaction.paymentType !== 'CREDIT' && transaction.paymentType !== 'INSTALLMENT')) {
      return; // Only recalculate for credit/installment transactions
    }

    // Delete existing payment schedules
    if (transaction.paymentSchedules.length > 0) {
      await this.prisma.paymentSchedule.deleteMany({
        where: { transactionId }
      });
    }

    // Get all items (both remaining and returned) to calculate original proportions
    const allItems = transaction.items;
    const remainingItems = allItems.filter(item => item.quantity > 0);
    
    if (remainingItems.length === 0) {
      return; // No items left, no need for schedules
    }

    // Calculate original transaction totals
    let originalTotalPrincipal = 0;
    let originalWeightedPercentSum = 0;
    let originalPercentWeightBase = 0;
    let totalMonths = 0;

    // First pass: calculate original totals (including returned items)
    for (const item of allItems) {
      const originalQuantity = item.quantity + (item.status === 'RETURNED' ? 0 : 0); // Get original quantity before returns
      const principal = (item.price || 0) * originalQuantity;
      originalTotalPrincipal += principal;
      if (item.creditPercent) {
        originalWeightedPercentSum += principal * (item.creditPercent || 0);
        originalPercentWeightBase += principal;
      }
      if (item.creditMonth) {
        totalMonths = Math.max(totalMonths, item.creditMonth || 0);
      }
    }

    // Calculate remaining totals
    let remainingTotalPrincipal = 0;
    let remainingWeightedPercentSum = 0;
    let remainingPercentWeightBase = 0;

    for (const item of remainingItems) {
      const principal = (item.price || 0) * (item.quantity || 0);
      remainingTotalPrincipal += principal;
      if (item.creditPercent) {
        remainingWeightedPercentSum += principal * (item.creditPercent || 0);
        remainingPercentWeightBase += principal;
      }
    }

    if (remainingTotalPrincipal > 0 && totalMonths > 0) {
      // Calculate proportional upfront payment for remaining items
      const originalUpfrontPayment = transaction.amountPaid || 0;
      const upfrontRatio = originalTotalPrincipal > 0 ? remainingTotalPrincipal / originalTotalPrincipal : 0;
      const proportionalUpfront = originalUpfrontPayment * upfrontRatio;
      
      const remainingPrincipal = Math.max(0, remainingTotalPrincipal - proportionalUpfront);
      const effectivePercent = remainingPercentWeightBase > 0 ? (remainingWeightedPercentSum / remainingPercentWeightBase) : 0;
      
      console.log('=== RECALCULATING PAYMENT SCHEDULE ===');
      console.log('originalTotalPrincipal:', originalTotalPrincipal);
      console.log('remainingTotalPrincipal:', remainingTotalPrincipal);
      console.log('originalUpfrontPayment:', originalUpfrontPayment);
      console.log('proportionalUpfront:', proportionalUpfront);
      console.log('remainingPrincipal:', remainingPrincipal);
      console.log('effectivePercent:', effectivePercent);
      
      const interestAmount = remainingPrincipal * effectivePercent;
      const remainingWithInterest = remainingPrincipal + interestAmount;
      const monthlyPayment = remainingWithInterest / totalMonths;
      let remainingBalance = remainingWithInterest;
      
      console.log('interestAmount:', interestAmount);
      console.log('remainingWithInterest:', remainingWithInterest);
      console.log('monthlyPayment:', monthlyPayment);

      const schedules: { transactionId: number; month: number; payment: number; remainingBalance: number; isPaid: boolean; paidAmount: number; }[] = [];
      for (let month = 1; month <= totalMonths; month++) {
        // For the last month, use the exact remaining balance to avoid floating point errors
        const currentPayment = month === totalMonths ? remainingBalance : monthlyPayment;
        remainingBalance -= currentPayment;
        schedules.push({
          transactionId,
          month,
          payment: currentPayment,
          remainingBalance: Math.max(0, remainingBalance),
          isPaid: false,
          paidAmount: 0
        });
      }

      if (schedules.length > 0) {
        await this.prisma.paymentSchedule.createMany({
          data: schedules
        });
      }

      // Update transaction totals
      await this.prisma.transaction.update({
        where: { id: transactionId },
        data: { 
          total: remainingTotalPrincipal,
          finalTotal: remainingWithInterest
        }
      });
    }
  }

  async create(createDefectiveLogDto: CreateDefectiveLogDto) {
    const { productId, quantity, description, userId, branchId, actionType = 'DEFECTIVE', isFromSale, transactionId, customerId, cashAdjustmentDirection, cashAmount: cashAmountInput, exchangeWithProductId, replacementQuantity, replacementUnitPrice, createdAt, handledByUserId } = createDefectiveLogDto;

    // Check if product exists
    const product = await this.prisma.product.findUnique({
      where: { id: productId }
    });

    if (!product) {
      throw new NotFoundException('Mahsulot topilmadi');
    }

    // Check if branch exists
    if (branchId) {
      const branch = await this.prisma.branch.findUnique({
        where: { id: branchId }
      });
      if (!branch) {
        throw new NotFoundException('Filial topilmadi');
      }
    }

    // Validate quantity based on action type
    if (actionType === 'DEFECTIVE') {
      // If this is from a sale, do not validate against current store quantity
      if (!isFromSale) {
        if (quantity > product.quantity) {
          throw new BadRequestException(`Defective miqdori mavjud miqdordan ko'p bo'lishi mumkin emas. Mavjud: ${product.quantity}, so'ralgan: ${quantity}`);
        }
      }
    }

    // Calculate cash amount based on action type
    let cashAmount = 0;
    let newQuantity = product.quantity;
    let newDefectiveQuantity = product.defectiveQuantity;
    let newReturnedQuantity = product.returnedQuantity;
    let newExchangedQuantity = product.exchangedQuantity;
    let newStatus = product.status;

    switch (actionType) {
      case 'DEFECTIVE':
        // Kassadan pul chiqadi (mahsulot narhi)
        cashAmount = -(product.price * quantity);
        // If from sale, do not reduce store quantity, only track defective count
        if (isFromSale) {
          newQuantity = product.quantity; // unchanged in store
        } else {
          newQuantity = Math.max(0, product.quantity - quantity);
        }
        newDefectiveQuantity = product.defectiveQuantity + quantity;
        newStatus = newQuantity === 0 ? ProductStatus.DEFECTIVE : ProductStatus.IN_STORE;
        break;

      case 'FIXED':
        // Kassaga pul qaytadi (mahsulot narhi)
        cashAmount = product.price * quantity;
        newDefectiveQuantity = Math.max(0, product.defectiveQuantity - quantity);
        newQuantity = product.quantity + quantity;
        newStatus = ProductStatus.IN_STORE;
        break;

      case 'RETURN':
        // Respect explicit cashier override ONLY when a positive amount is provided
        if (typeof cashAmountInput === 'number' && Math.abs(Number(cashAmountInput)) > 0 && cashAdjustmentDirection) {
          cashAmount = (cashAdjustmentDirection === 'PLUS' ? 1 : -1) * Math.abs(Number(cashAmountInput) || 0);
        } else {
          // Compute refund from original sale line if available, else fallback to product price
          if (isFromSale && transactionId) {
            const tx = await this.prisma.transaction.findUnique({
              where: { id: Number(transactionId) },
              include: { items: true }
            });
            const line = tx?.items?.find((it: any) => Number(it.productId) === Number(productId));
            const unit = Number((line?.sellingPrice ?? line?.price ?? product.price) || 0);
            cashAmount = -(unit * quantity);
          } else {
            cashAmount = -(product.price * quantity);
          }
        }
        newReturnedQuantity = product.returnedQuantity + quantity;
        newStatus = ProductStatus.RETURNED;
        // Returned items increase store stock back
        newQuantity = product.quantity + quantity;
        break;

      case 'EXCHANGE':
        // Respect explicit cashier override when provided
        if (typeof cashAmountInput === 'number' && cashAdjustmentDirection) {
          cashAmount = (cashAdjustmentDirection === 'PLUS' ? 1 : -1) * Math.abs(Number(cashAmountInput) || 0);
        } else {
          // Default behavior: money enters cashbox (positive) for replacement price delta can be handled client-side
          cashAmount = product.price * quantity;
        }
        newExchangedQuantity = product.exchangedQuantity + quantity;
        newStatus = ProductStatus.EXCHANGED;
        // Exchanged returns increase original stock
        newQuantity = product.quantity + quantity;
        break;

      default:
        throw new BadRequestException('Noto\'g\'ri action type');
    }

    // Recalc trigger flags (to run AFTER transaction completes)
    let shouldRecalculate = false;
    let recalcForTxId: number | null = null;

    // Use transaction to ensure data consistency (keep it short)
    const result = await this.prisma.$transaction(async (prisma) => {
      // Create defective log
      const defectiveLog = await prisma.defectiveLog.create({
        data: {
          productId,
          quantity,
          description,
          userId,
          branchId,
          cashAmount,
          actionType,
          // persist optional linkage and audit fields
          transactionId: transactionId ? Number(transactionId) : undefined,
          handledByUserId: handledByUserId ? Number(handledByUserId) : undefined,
          cashAdjustmentDirection: cashAdjustmentDirection || undefined,
          // allow overriding createdAt to align with selected day
          ...(createdAt ? { createdAt: new Date(createdAt) } : {}),
        },
        include: {
          product: true,
          user: true,
          branch: true
        }
      });

      // Update product quantities and status
      await prisma.product.update({
        where: { id: productId },
        data: {
          quantity: newQuantity,
          defectiveQuantity: newDefectiveQuantity,
          returnedQuantity: newReturnedQuantity,
          exchangedQuantity: newExchangedQuantity,
          status: newStatus
        }
      });

      // When linked to a sale, mutate the Transaction items accordingly
      if (isFromSale && transactionId) {
        const tx = await prisma.transaction.findUnique({
          where: { id: Number(transactionId) },
          include: { items: true }
        });
        if (tx) {
          // Find the original item for productId
          const orig = tx.items.find(i => i.productId === productId);
          if (orig) {
            // Guard against over-deduction: cannot return/exchange more than sold in this line
            if (Number(quantity) > Number(orig.quantity)) {
              throw new BadRequestException(`Tanlangan sotuvda mavjud miqdordan ko'p (${orig.quantity}) qaytarib/almashtirib bo'lmaydi`);
            }

            if (actionType === 'RETURN' || actionType === 'EXCHANGE') {
              const remainingQty = Math.max(0, Number(orig.quantity) - Number(quantity));
              if (remainingQty === 0) {
                // Instead of deleting, mark as returned with status (if column exists)
                await prisma.transactionItem.update({
                  where: { id: orig.id },
                  data: {
                    quantity: 0,
                    total: 0,
                    // status column must exist in DB; ensure migration applied
                    status: 'RETURNED'
                  }
                });
              } else {
                const unitPrice = (orig.sellingPrice ?? orig.price) || 0;
                await prisma.transactionItem.update({
                  where: { id: orig.id },
                  data: {
                    quantity: remainingQty,
                    total: remainingQty * unitPrice
                  }
                });
              }

              // BONUS REVERSAL: Return all bonus products given for this transaction and delete related bonus rows
              if (actionType === 'RETURN') {
                // Restock all transaction bonus products back to inventory once
                const txBonusProducts = await prisma.transactionBonusProduct.findMany({ where: { transactionId: tx.id } });
                if (txBonusProducts.length > 0) {
                  for (const bp of txBonusProducts) {
                    try {
                      await prisma.product.update({
                        where: { id: bp.productId },
                        data: { quantity: { increment: Number(bp.quantity || 0) } }
                      });
                    } catch (_) { /* ignore single product failures to avoid blocking whole return */ }
                  }
                  // Remove TransactionBonusProduct rows to prevent double-restock on subsequent returns
                  await prisma.transactionBonusProduct.deleteMany({ where: { transactionId: tx.id } });
                }

                // Delete all bonuses tied to this transaction (sales bonus, penalty, updates)
                await (prisma as any).bonus.deleteMany({ where: { transactionId: tx.id } });
                // Adjust extraProfit proportionally based on returned quantity
                const originalProfit = tx.extraProfit || 0;
                const originalQty = Number(orig.quantity) + Number(quantity);
                const proportionalProfit = originalProfit * (Number(quantity) / originalQty);
                const newProfit = Math.max(0, originalProfit - proportionalProfit);
                await prisma.transaction.update({ 
                  where: { id: tx.id }, 
                  data: { extraProfit: newProfit } 
                });
              }
            }

            if (actionType === 'EXCHANGE') {
              const replacementQty = Math.max(1, Number(replacementQuantity || quantity) || quantity);

              const replProdId = Number(exchangeWithProductId);
              const replPrice = Number(replacementUnitPrice ?? 0);

              // Idempotency/merge guard: if a replacement item with same product and price was just added, update it instead of creating duplicate
              const existingRepl = await prisma.transactionItem.findFirst({
                where: { transactionId: tx.id, productId: replProdId, price: replPrice },
                orderBy: { createdAt: 'desc' }
              });

              if (existingRepl) {
                await prisma.transactionItem.update({
                  where: { id: existingRepl.id },
                  data: {
                    quantity: existingRepl.quantity + replacementQty,
                    total: (existingRepl.quantity + replacementQty) * (existingRepl.sellingPrice ?? existingRepl.price)
                  }
                });
              } else {
                // add new replacement item
                await prisma.transactionItem.create({
                  data: {
                    transactionId: tx.id,
                    productId: replProdId,
                    quantity: replacementQty,
                    price: replPrice,
                    sellingPrice: replPrice,
                    originalPrice: replPrice,
                    total: replacementQty * replPrice
                  }
                });
              }

              // decrement stock for replacement product by replacementQty
              const repl = await prisma.product.findUnique({ where: { id: replProdId } });
              if (!repl) {
                throw new NotFoundException('Almashtiriladigan mahsulot topilmadi');
              }
              if (replacementQty > repl.quantity) {
                throw new BadRequestException(`Almashtirish miqdori mavjud miqdordan ko'p. Mavjud: ${repl.quantity}, so'ralgan: ${replacementQty}`);
              }
              await prisma.product.update({
                where: { id: repl.id },
                data: { quantity: Math.max(0, repl.quantity - replacementQty) }
              });
            }
            
            // Recalculate totals (fast query)

            // Set recalc flag (run after transaction)
            if (tx.paymentType === 'CREDIT' || tx.paymentType === 'INSTALLMENT') {
              shouldRecalculate = true;
              recalcForTxId = tx.id;
            }

            // Skip recomputing bonuses on return: we already removed all bonuses above for this transaction
          }
        }
      }

      // Update branch cash balance
      if (branchId) {
        await prisma.branch.update({
          where: { id: branchId },
          data: {
            cashBalance: {
              increment: cashAmount
            }
          }
        });
      }

      return defectiveLog;
    }, { timeout: 15000 });

    // Perform schedule recalculation OUTSIDE of transaction to avoid timeouts
    if (shouldRecalculate && recalcForTxId) {
      try {
        await this.recalculatePaymentSchedules(recalcForTxId);
      } catch (_) {}
    }

    return result;
  }

  async getByCashier(cashierId: number, query: { startDate?: string; endDate?: string; branchId?: string; actionType?: string }) {
    const where: any = {
      OR: [
        { handledByUserId: Number(cashierId) },
        { userId: Number(cashierId) }
      ]
    };
    if (query?.branchId) {
      where.branchId = Number(query.branchId);
    }
    if (query?.actionType) {
      where.actionType = query.actionType;
    }
    if (query?.startDate || query?.endDate) {
      where.createdAt = {} as any;
      if (query.startDate) (where.createdAt as any).gte = new Date(query.startDate);
      if (query.endDate) (where.createdAt as any).lte = new Date(query.endDate);
    }

    const logs = await this.prisma.defectiveLog.findMany({
      where,
      orderBy: { createdAt: 'desc' }
    });

    let plus = 0;
    let minus = 0;
    const items: any[] = [];
    for (const log of logs) {
      const raw = Number((log as any).cashAmount ?? 0) || 0;
      const dir = String((log as any).cashAdjustmentDirection || '').toUpperCase();
      let signed = dir === 'MINUS' ? -Math.abs(raw) : dir === 'PLUS' ? Math.abs(raw) : raw;
      const isReturn = String((log as any).actionType || '').toUpperCase() === 'RETURN';
      if ((Number.isNaN(signed) ? 0 : signed) === 0 && isReturn) {
        const txId = (log as any).transactionId ? Number((log as any).transactionId) : null;
        if (txId) {
          const tx = await this.prisma.transaction.findUnique({ where: { id: txId }, include: { items: true, customer: true, soldBy: true } });
          if (tx && Array.isArray(tx.items)) {
            const it = tx.items.find((ii: any) => Number(ii.productId) === Number((log as any).productId));
            const unit = Number((it?.sellingPrice ?? it?.price) || 0);
            const qty = Number((log as any).quantity || 0);
            if (unit > 0 && qty > 0) signed = -Math.abs(unit * qty);
          }
        }
      }
      if ((Number.isNaN(signed) ? 0 : signed) === 0) continue;
      if (signed > 0) plus += signed; else minus += Math.abs(signed);
      if (isReturn && signed < 0) {
        let tx: any = null;
        const txId = (log as any).transactionId ? Number((log as any).transactionId) : null;
        if (txId) {
          tx = await this.prisma.transaction.findUnique({ where: { id: txId }, include: { customer: true, soldBy: true } });
        }
        items.push({
          id: (log as any).id,
          createdAt: (log as any).createdAt,
          amount: Math.abs(signed),
          transactionId: txId,
          productId: (log as any).productId,
          quantity: (log as any).quantity,
          customer: tx?.customer || null,
          soldBy: tx?.soldBy || null,
        });
      }
    }

    return { plus, minus, items };
  }

  async findAll(query: any = {}) {
    const { branchId, actionType, startDate, endDate } = query;
    
    const where: any = {};
    
    if (branchId) {
      where.branchId = parseInt(branchId);
    }
    
    if (actionType) {
      where.actionType = actionType;
    }
    
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }

    return this.prisma.defectiveLog.findMany({
      where,
      include: {
        product: true,
        user: true,
        branch: true
      },
      orderBy: {
        createdAt: 'desc'
      }
    });
  }

  async findByProduct(productId: number) {
    return this.prisma.defectiveLog.findMany({
      where: { productId },
      include: {
        product: true,
        user: true,
        branch: true
      },
      orderBy: {
        createdAt: 'desc'
      }
    });
  }

  async findOne(id: number) {
    const defectiveLog = await this.prisma.defectiveLog.findUnique({
      where: { id },
      include: {
        product: true,
        user: true,
        branch: true
      }
    });

    if (!defectiveLog) {
      throw new NotFoundException('Defective log topilmadi');
    }

    return defectiveLog;
  }

  async update(id: number, updateDefectiveLogDto: UpdateDefectiveLogDto) {
    const defectiveLog = await this.findOne(id);

    return this.prisma.defectiveLog.update({
      where: { id },
      data: updateDefectiveLogDto,
      include: {
        product: true,
        user: true,
        branch: true
      }
    });
  }

  async markAsFixed(productId: number, quantity: number, userId?: number, branchId?: number) {
    return this.create({
      productId,
      quantity,
      description: 'Mahsulot tuzatildi',
      userId,
      branchId,
      actionType: 'FIXED'
    });
  }

  async returnProduct(productId: number, quantity: number, description: string, userId?: number, branchId?: number) {
    return this.create({
      productId,
      quantity,
      description,
      userId,
      branchId,
      actionType: 'RETURN'
    });
  }

  async exchangeProduct(productId: number, quantity: number, description: string, userId?: number, branchId?: number) {
    return this.create({
      productId,
      quantity,
      description,
      userId,
      branchId,
      actionType: 'EXCHANGE'
    });
  }

  async remove(id: number) {
    const defectiveLog = await this.findOne(id);

    return this.prisma.defectiveLog.delete({
      where: { id }
    });
  }

  async getDefectiveProducts(branchId?: number) {
    const where: any = {
      status: ProductStatus.DEFECTIVE
    };
    
    if (branchId) {
      where.branchId = branchId;
    }

    return this.prisma.product.findMany({
      where,
      include: {
        category: true,
        branch: true,
        DefectiveLog: {
          include: {
            user: true
          },
          orderBy: {
            createdAt: 'desc'
          }
        }
      }
    });
  }

  async getFixedProducts(branchId?: number) {
    const where: any = {
      status: ProductStatus.FIXED
    };
    
    if (branchId) {
      where.branchId = branchId;
    }

    return this.prisma.product.findMany({
      where,
      include: {
        category: true,
        branch: true,
        DefectiveLog: {
          include: {
            user: true
          },
          orderBy: {
            createdAt: 'desc'
          }
        }
      }
    });
  }

  async getReturnedProducts(branchId?: number) {
    const where: any = {
      status: ProductStatus.RETURNED
    };
    
    if (branchId) {
      where.branchId = branchId;
    }

    return this.prisma.product.findMany({
      where,
      include: {
        category: true,
        branch: true,
        DefectiveLog: {
          include: {
            user: true
          },
          orderBy: {
            createdAt: 'desc'
          }
        }
      }
    });
  }

  async getExchangedProducts(branchId?: number) {
    const where: any = {
      status: ProductStatus.EXCHANGED
    };
    
    if (branchId) {
      where.branchId = branchId;
    }

    return this.prisma.product.findMany({
      where,
      include: {
        category: true,
        branch: true,
        DefectiveLog: {
          include: {
            user: true
          },
          orderBy: {
            createdAt: 'desc'
          }
        }
      }
    });
  }

  // Get statistics for dashboard
  async getStatistics(branchId?: number, startDate?: string, endDate?: string) {
    const where: any = {};
    
    if (branchId) {
      where.branchId =branchId;
    }
    
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }

    const [defectiveStats, fixedStats, returnStats, exchangeStats, cashFlow] = await Promise.all([
      // Defective products
      this.prisma.defectiveLog.aggregate({
        where: { ...where, actionType: 'DEFECTIVE' },
        _sum: { quantity: true, cashAmount: true },
        _count: true
      }),
      // Fixed products
      this.prisma.defectiveLog.aggregate({
        where: { ...where, actionType: 'FIXED' },
        _sum: { quantity: true, cashAmount: true },
        _count: true
      }),
      // Returned products
      this.prisma.defectiveLog.aggregate({
        where: { ...where, actionType: 'RETURN' },
        _sum: { quantity: true, cashAmount: true },
        _count: true
      }),
      // Exchanged products
      this.prisma.defectiveLog.aggregate({
        where: { ...where, actionType: 'EXCHANGE' },
        _sum: { quantity: true, cashAmount: true },
        _count: true
      }),
      // Total cash flow
      this.prisma.defectiveLog.aggregate({
        where,
        _sum: { cashAmount: true }
      })
    ]);

    return {
      defectiveProducts: {
        quantity: defectiveStats._sum.quantity || 0,
        cashAmount: defectiveStats._sum.cashAmount || 0,
        count: defectiveStats._count || 0
      },
      fixedProducts: {
        quantity: fixedStats._sum.quantity || 0,
        cashAmount: fixedStats._sum.cashAmount || 0,
        count: fixedStats._count || 0
      },
      returnedProducts: {
        quantity: returnStats._sum.quantity || 0,
        cashAmount: returnStats._sum.cashAmount || 0,
        count: returnStats._count || 0
      },
      exchangedProducts: {
        quantity: exchangeStats._sum.quantity || 0,
        cashAmount: exchangeStats._sum.cashAmount || 0,
        count: exchangeStats._count || 0
      },
      totalCashFlow: cashFlow._sum.cashAmount || 0
    };
  }
}
