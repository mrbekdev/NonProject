// dto/create-transaction.dto.ts
import { IsEnum, IsOptional, IsNumber, IsArray, ValidateNested, IsString, Min, Max, IsPositive } from 'class-validator';
import { Type } from 'class-transformer';
import { TransactionStatus, PaymentType, TransactionType } from '@prisma/client';

export class CustomerDto {
  @IsString()
  fullName?: string;

  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  passportSeries?: string; 

  @IsOptional()
  @IsString()
  jshshir?: string; 
}

export class TransactionItemDto {
  @IsNumber()
  @IsPositive()
  productId: number;

  @IsOptional()
  @IsString()
  productName?: string; // Product name for display

  @IsNumber()
  @IsPositive()
  quantity: number;

  @IsNumber()
  @Min(0)
  price: number; // Narx nol bo'lishi mumkin

  @IsOptional()
  @IsNumber()
  @Min(0)
  sellingPrice?: number; // Actual selling price (can be different from product.price)

  @IsOptional()
  @IsNumber()
  @Min(0)
  originalPrice?: number; // Original product price at time of sale

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(24)
  creditMonth?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  creditPercent?: number; // 0.05 = 5%

  @IsOptional()
  @IsNumber()
  @Min(0)
  monthlyPayment?: number; // Hisoblash uchun, client tomonidan berilmasa ham bo'ladi

  @IsOptional()
  @IsNumber()
  @Min(0)
  total?: number; // Total amount for this item
}

export class PaymentBreakdownDto {
  @IsString()
  method: 'CASH' | 'CARD' | 'TERMINAL';

  @IsNumber()
  @Min(0)
  amount: number;
}

export class CreateTransactionDto {
  @IsOptional()
  @IsNumber()
  @IsPositive()
  userId?: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  soldByUserId?: number; // Kim sotganini saqlash uchun

  @IsNumber()
  @IsPositive()
  fromBranchId: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  toBranchId?: number;

  @IsEnum(TransactionType)
  type: TransactionType;

  @IsOptional()
  @IsString()
  transactionType?: string; // Qo'shimcha transaction turi (SALE, PURCHASE, TRANSFER, RETURN, etc.)

  @IsOptional()
  @IsEnum(TransactionStatus)
  status?: TransactionStatus;

  @IsNumber()
  @Min(0) // Nol ham bo'lishi mumkin
  total: number;

  @IsNumber()
  @Min(0)
  finalTotal: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  downPayment?: number; // Boshlang'ich to'lov

  @IsOptional()
  @IsNumber()
  @Min(0)
  amountPaid?: number; // Amount already paid

  @IsOptional()
  @IsNumber()
  @Min(0)
  remainingBalance?: number; // Remaining balance

  @IsOptional()
  @IsEnum(PaymentType)
  paymentType?: PaymentType;

  @IsOptional()
  @IsString()
  upfrontPaymentType?: 'CASH' | 'CARD' | 'TERMINAL'; // CASH, CARD or TERMINAL for upfront payments

  @IsOptional()
  @IsString()
  termUnit?: 'MONTHS' | 'DAYS'; // MONTHS or DAYS for payment terms

  @IsOptional()
  @IsString()
  deliveryType?: string; // PICKUP or DELIVERY

  @IsOptional()
  @IsString()
  deliveryAddress?: string; // Delivery address for customer

  @IsOptional()
  @ValidateNested()
  @Type(() => CustomerDto)
  customer?: CustomerDto;

  @IsArray({ message: 'Items must be an array' })
  @ValidateNested({ each: true })
  @Type(() => TransactionItemDto)
  items: TransactionItemDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PaymentBreakdownDto)
  payments?: PaymentBreakdownDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PaymentBreakdownDto)
  paymentBreakdowns?: PaymentBreakdownDto[];

  // Validationni service da qilish maqsadga muvofiq
}