import { IsString, IsNumber, IsOptional, IsEnum, Min } from 'class-validator';
import { ProductStatus } from '@prisma/client';

export class CreateProductDto {
  @IsString()
  name: string;

  @IsString()
  @IsOptional()
  barcode?: string;

  @IsString()
  @IsOptional()
  model?: string;

  @IsNumber()
  @Min(0)
  price: number;

  @IsNumber()
  @Min(0)
  quantity: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  marketPrice?: number;

  @IsNumber()
  categoryId: number;

  @IsNumber()
  branchId: number;

  @IsEnum(ProductStatus)
  @IsOptional()
  status?: ProductStatus;

  @IsString()
  @IsOptional()
  description?: string;



  @IsString()
  @IsOptional()
  unitType?: string;

  @IsNumber()
  @Min(0)
  @IsOptional()
  bonusPercentage?: number;

  @IsString()
  @IsOptional()
  months?: string;
}