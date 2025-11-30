import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { Prisma, PrismaClient, ProductStatus } from '@prisma/client';
import * as XLSX from 'xlsx';
import { CurrencyExchangeRateService } from '../currency-exchange-rate/currency-exchange-rate.service';

@Injectable()
export class ProductService {
  constructor(
    private prisma: PrismaService,
    private currencyExchangeRateService: CurrencyExchangeRateService,
  ) {}
private async generateUniqueBarcode(tx: any): Promise<string> {
  // mavjud counterni olamiz yoki 0 yaratib qo'yamiz
  let counterRecord = await tx.barcodeCounter.findFirst();

  if (!counterRecord) {
    counterRecord = await tx.barcodeCounter.create({
      data: { counter: 1n }, // 1 dan boshlaymiz
    });
  } else {
    counterRecord = await tx.barcodeCounter.update({
      where: { id: counterRecord.id },
      data: {
        counter: { increment: 1 }, // ✅ Prisma o'zi +1 qiladi
      },
    });
  }

  return counterRecord.counter.toString();
}

async create(
  createProductDto: CreateProductDto,
  userId: number,
  prismaClient: PrismaClient | Prisma.TransactionClient = this.prisma,
) {
  // Convert quantity to grams if unitType is KG
  const inputQuantity = Number(createProductDto.quantity);
  if (isNaN(inputQuantity)) {
    throw new BadRequestException('Invalid quantity value');
  }
  
  const quantity = createProductDto.unitType === 'KG' 
    ? Math.round(inputQuantity)  // Convert KG to grams for storage
    : Math.round(inputQuantity);

  const product = await prismaClient.product.create({
    data: {
      name: createProductDto.name,
      barcode: await this.generateUniqueBarcode(prismaClient),
      categoryId: createProductDto.categoryId,
      branchId: createProductDto.branchId,
      price: createProductDto.price,
      marketPrice: createProductDto.marketPrice,
      model: createProductDto.model,
      months: createProductDto.months,
      unitType: createProductDto.unitType || 'PIECE',
      initialQuantity: quantity,
      quantity: quantity,
      status: createProductDto.status || 'IN_STORE',
      defectiveQuantity: 0,
      bonusPercentage: createProductDto.bonusPercentage || 0,
    },
  });

  if (createProductDto.quantity && createProductDto.quantity > 0) {
    const transaction = await prismaClient.transaction.create({
      data: {
        userId,
        type: 'PURCHASE',
        status: 'COMPLETED',
        discount: 0,
        total: 0,
        finalTotal: 0,
        amountPaid: 0,
        remainingBalance: 0,
        description: 'Initial stock for product creation',
      },
    });

    await prismaClient.transactionItem.create({
      data: {
        transactionId: transaction.id,
        productId: product.id,
        quantity: createProductDto.quantity,
        price: 0,
        total: 0,
      },
    });
  }

  return product;
}


  async findAll(branchId?: number, search?: string, includeZeroQuantity: boolean = false) {
    const where: Prisma.ProductWhereInput = {};
    if (branchId) where.branchId = +branchId;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { barcode: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (!includeZeroQuantity) {
      where.quantity = { gt: 0 };
    }
    const products = await this.prisma.product.findMany({
      where,
      include: { category: true, branch: true },
      orderBy: { id: 'asc' },
    });

    // Convert prices to som for display
    const productsWithSomPrices = await Promise.all(
      products.map(async (product) => {
        const priceInSom = await this.currencyExchangeRateService.convertCurrency(
          product.price,
          'USD',
          'UZS',
          product.branchId,
        );
        return {
          ...product,
          priceInSom,
          priceInDollar: product.price,
        };
      }),
    );

    return productsWithSomPrices;
  }

  async findOne(id: number) {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: {
        branch: true,
        category: true,
      },
    });

    if (!product) {
      throw new NotFoundException('Mahsulot topilmadi');
    }
    
    // Convert price to som for display
    const priceInSom = await this.currencyExchangeRateService.convertCurrency(
      product.price,
      'USD',
      'UZS',
      product.branchId,
    );

    return {
      ...product,
      priceInSom,
      priceInDollar: product.price,
    };
  }

  async findOneByBranch(id: number, branchId: number) {
    const product = await this.prisma.product.findFirst({
      where: { 
        id,
        branchId 
      },
      include: {
        branch: true,
        category: true,
      },
    });

    if (!product) {
      throw new NotFoundException('Mahsulot topilmadi');
    }
    
    // Convert price to som for display
    const priceInSom = await this.currencyExchangeRateService.convertCurrency(
      product.price,
      'USD',
      'UZS',
      product.branchId,
    );

    return {
      ...product,
      priceInSom,
      priceInDollar: product.price,
    };
  }

async update(
  id: number,
  updateProductDto: UpdateProductDto,
  userId: number,
  prismaClient: PrismaClient | Prisma.TransactionClient = this.prisma,
) {
  const product = await prismaClient.product.findUnique({ where: { id } });
  if (!product) {
    throw new NotFoundException('Mahsulot topilmadi');
  }

  // Check if price, marketPrice or bonusPercentage is being updated
  const isPriceUpdated = updateProductDto.price !== undefined && updateProductDto.price !== product.price;
  const isMarketPriceUpdated = updateProductDto.marketPrice !== undefined && updateProductDto.marketPrice !== product.marketPrice;
  const isBonusUpdated = updateProductDto.bonusPercentage !== undefined && updateProductDto.bonusPercentage !== product.bonusPercentage;

  // Handle quantity conversion based on unitType
  let quantity = product.quantity;
  if (updateProductDto.quantity !== undefined) {
    // Convert input to number and handle KG conversion if needed
    const inputQuantity = Number(updateProductDto.quantity);
    if (isNaN(inputQuantity)) {
      throw new BadRequestException('Invalid quantity value');
    }
    
    quantity = updateProductDto.unitType === 'KG' 
      ? Math.round(inputQuantity * 1000)  // Convert KG to grams for storage
      : Math.round(inputQuantity);
      
  } else if (updateProductDto.unitType && updateProductDto.unitType !== product.unitType) {
    // If only unitType is changing, convert the existing quantity
    if (updateProductDto.unitType === 'KG' && product.unitType === 'PIECE') {
      // Converting from pieces to grams (multiply by 1000)
      quantity = Math.round(quantity * 1000);
    } else if (updateProductDto.unitType === 'PIECE' && product.unitType === 'KG') {
      // Converting from grams to pieces (divide by 1000)
      quantity = Math.round(quantity / 1000);
    }
  }

  const updateData = {
    name: updateProductDto.name,
    categoryId: updateProductDto.categoryId,
    branchId: updateProductDto.branchId,
    price: updateProductDto.price,
    marketPrice: updateProductDto.marketPrice,
    model: updateProductDto.model,
    unitType: updateProductDto.unitType,
    months: updateProductDto.months,
    status: updateProductDto.status,
    quantity: quantity,
    bonusPercentage: updateProductDto.bonusPercentage,
  };

  const updatedProduct = await prismaClient.product.update({
    where: { id },
    data: updateData,
  });

  // If price, marketPrice or bonusPercentage is updated, sync with all products having same name and model
  if ((isPriceUpdated || isMarketPriceUpdated || isBonusUpdated) && updatedProduct.name && updatedProduct.model) {
    const updateData: any = {};
    if (isPriceUpdated) {
      updateData.price = updatedProduct.price;
    }
    if (isMarketPriceUpdated) {
      updateData.marketPrice = updatedProduct.marketPrice;
    }
    if (isBonusUpdated) {
      updateData.bonusPercentage = updatedProduct.bonusPercentage;
    }

    // Update all products with same name and model across all branches
    await prismaClient.product.updateMany({
      where: {
        name: updatedProduct.name,
        model: updatedProduct.model,
        id: { not: id }, // Exclude the current product
      },
      data: updateData,
    });
  }

  // Convert price to som for display
  const priceInSom = await this.currencyExchangeRateService.convertCurrency(
    updatedProduct.price,
    'USD',
    'UZS',
    updatedProduct.branchId,
  );

  return {
    ...updatedProduct,
    priceInSom,
    priceInDollar: updatedProduct.price,
  };
}

  // Mahsulotni DEFECTIVE qilib belgilash (to'liq mahsulot
  async markAsDefective(id: number, description: string, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const product = await tx.product.findUnique({ where: { id } });
      if (!product) {
        throw new NotFoundException('Mahsulot topilmadi');
      }

      if (product.quantity === 0) {
        throw new BadRequestException('Mahsulot miqdori 0 ga teng, defective qilib bo\'lmaydi');
      }

      const defectiveQty = product.quantity;

      const updatedProduct = await tx.product.update({
        where: { id },
        data: {
          status: 'DEFECTIVE',
          defectiveQuantity: (product.defectiveQuantity || 0) + defectiveQty,
          quantity: 0,
        },
      });

      await tx.defectiveLog.create({
        data: {
          productId: id,
          quantity: defectiveQty,
          description,
          userId,
        },
      });

      const transDesc = `Mahsulot to'liq defective qilib belgilandi. ${defectiveQty} ta. Sababi: ${description}`;

      const transaction = await tx.transaction.create({
        data: {
          userId,
          type: 'WRITE_OFF',
          status: 'COMPLETED',
          discount: 0,
          total: 0,
          finalTotal: 0,
          amountPaid: 0,
          remainingBalance: 0,
          description: transDesc,
        },
      });

      await tx.transactionItem.create({
        data: {
          transactionId: transaction.id,
          productId: id,
          quantity: defectiveQty,
          price: 0,
          total: 0,
        },
      });

      return updatedProduct;
    });
  }

  // Mahsulotdan ma'lum miqdorini DEFECTIVE qilib belgilash
  async markPartialDefective(id: number, defectiveCount: number, description: string, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const product = await tx.product.findUnique({ where: { id } });
      if (!product) {
        throw new NotFoundException('Mahsulot topilmadi');
      }

      if (defectiveCount <= 0) {
        throw new BadRequestException('Defective miqdor 0 dan katta bo\'lishi kerak');
      }

      if (defectiveCount > product.quantity) {
        throw new BadRequestException('Defective miqdor mavjud mahsulot miqdoridan ko\'p bo\'lishi mumkin emas');
      }

      const newQuantity = product.quantity - defectiveCount;
      const newDefectiveQuantity = (product.defectiveQuantity || 0) + defectiveCount;

      const updatedProduct = await tx.product.update({
        where: { id },
        data: {
          quantity: newQuantity,
          defectiveQuantity: newDefectiveQuantity,
          status: newQuantity === 0 ? 'DEFECTIVE' : product.status,
        },
      });

      await tx.defectiveLog.create({
        data: {
          productId: id,
          quantity: defectiveCount,
          description,
          userId,
        },
      });

      const transDesc = `${defectiveCount} ta mahsulot defective qilib belgilandi. Sababi: ${description}`;

      const transaction = await tx.transaction.create({
        data: {
          userId,
          type: 'WRITE_OFF',
          status: 'COMPLETED',
          discount: 0,
          total: 0,
          finalTotal: 0,
          amountPaid: 0,
          remainingBalance: 0,
          description: transDesc,
        },
      });

      await tx.transactionItem.create({
        data: {
          transactionId: transaction.id,
          productId: id,
          quantity: defectiveCount,
          price: 0,
          total: 0,
        },
      });

      return updatedProduct;
    });
  }

  // Defective mahsulotlarni qaytarish (restore)
  async restoreDefectiveProduct(id: number, restoreCount: number, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const product = await tx.product.findUnique({ where: { id } });
      if (!product) {
        throw new NotFoundException('Mahsulot topilmadi');
      }

      if (!product.defectiveQuantity || product.defectiveQuantity === 0) {
        throw new BadRequestException('Bu mahsulotda defective miqdor mavjud emas');
      }

      if (restoreCount <= 0) {
        throw new BadRequestException('Qaytarish miqdori 0 dan katta bo\'lishi kerak');
      }

      if (restoreCount > product.defectiveQuantity) {
        throw new BadRequestException('Qaytarish miqdori defective miqdoridan ko\'p bo\'lishi mumkin emas');
      }

      const newQuantity = product.quantity + restoreCount;
      const newDefectiveQuantity = product.defectiveQuantity - restoreCount;

      const updatedProduct = await tx.product.update({
        where: { id },
        data: {
          quantity: newQuantity,
          defectiveQuantity: newDefectiveQuantity,
          status: newDefectiveQuantity === 0 ? 'FIXED' : product.status,
        },
      });

      const transDesc = `${restoreCount} ta defective mahsulot qaytarildi`;

      const transaction = await tx.transaction.create({
        data: {
          userId,
          type: 'RETURN',
          status: 'COMPLETED',
          discount: 0,
          total: 0,
          finalTotal: 0,
          amountPaid: 0,
          remainingBalance: 0,
          description: transDesc,
        },
      });

      await tx.transactionItem.create({
        data: {
          transactionId: transaction.id,
          productId: id,
          quantity: restoreCount,
          price: 0,
          total: 0,
        },
      });

      return updatedProduct;
    });
  }

  // Bulk defective (to'liq defective qilish bir necha mahsulot uchun)
  async bulkMarkDefective(ids: number[], description: string, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const products = await tx.product.findMany({ where: { id: { in: ids } } });
      if (products.length !== ids.length) {
        throw new NotFoundException('Ba\'zi mahsulotlar topilmadi');
      }

      for (const product of products) {
        if (product.quantity === 0) {
          continue; // Skip if no quantity
        }

        const defectiveQty = product.quantity;

        await tx.product.update({
          where: { id: product.id },
          data: {
            status: 'DEFECTIVE',
            defectiveQuantity: defectiveQty,
            quantity: 0,
          },
        });

        await tx.defectiveLog.create({
          data: {
            productId: product.id,
            quantity: defectiveQty,
            description,
            userId,
          },
        });

        const transDesc = `Bulk: Mahsulot to'liq defective qilib belgilandi. ${defectiveQty} ta. Sababi: ${description}`;

        const transaction = await tx.transaction.create({
          data: {
            userId,
            type: 'WRITE_OFF',
            status: 'COMPLETED',
            discount: 0,
            total: 0,
            finalTotal: 0,
            amountPaid: 0,
            remainingBalance: 0,
            description: transDesc,
          },
        });

        await tx.transactionItem.create({
          data: {
            transactionId: transaction.id,
            productId: product.id,
            quantity: defectiveQty,
            price: 0,
            total: 0,
          },
        });
      }

      return { message: 'Tanlangan mahsulotlar defective qilindi', count: ids.length };
    });
  }

  // Bulk restore defective (to'liq restore qilish bir necha mahsulot uchun)
  async bulkRestoreDefective(ids: number[], userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const products = await tx.product.findMany({ where: { id: { in: ids } } });
      if (products.length !== ids.length) {
        throw new NotFoundException('Ba\'zi mahsulotlar topilmadi');
      }

      for (const product of products) {
        if (!product.defectiveQuantity || product.defectiveQuantity === 0) {
          continue; // Skip if no defective quantity
        }

        const restoreCount = product.defectiveQuantity;
        const newQuantity = product.quantity + restoreCount;
        const newDefectiveQuantity = 0;

        await tx.product.update({
          where: { id: product.id },
          data: {
            quantity: newQuantity,
            defectiveQuantity: newDefectiveQuantity,
            status: 'FIXED',
          },
        });

        const transDesc = `Bulk: ${restoreCount} ta defective mahsulot qaytarildi`;

        const transaction = await tx.transaction.create({
          data: {
            userId,
            type: 'RETURN',
            status: 'COMPLETED',
            discount: 0,
            total: 0,
            finalTotal: 0,
            amountPaid: 0,
            remainingBalance: 0,
            description: transDesc,
          },
        });

        await tx.transactionItem.create({
          data: {
            transactionId: transaction.id,
            productId: product.id,
            quantity: restoreCount,
            price: 0,
            total: 0,
          },
        });
      }

      return { message: 'Tanlangan defective mahsulotlar qaytarildi', count: ids.length };
    });
  }

  // Defective mahsulotlar ro'yxati
  async getDefectiveProducts(branchId?: number) {
    const where: Prisma.ProductWhereInput = {
      defectiveQuantity: { gt: 0 },
    };

    if (branchId) {
      where.branchId = branchId;
    }

    const products = await this.prisma.product.findMany({
      where,
      include: {
        category: true,
        branch: true,
      },
      orderBy: { id: 'asc' },
    });

    // Convert prices to som for display
    const productsWithSomPrices = await Promise.all(
      products.map(async (product) => {
        const priceInSom = await this.currencyExchangeRateService.convertCurrency(
          product.price,
          'USD',
          'UZS',
          product.branchId,
        );
        return {
          ...product,
          priceInSom,
          priceInDollar: product.price,
        };
      }),
    );

    return productsWithSomPrices;
  }

  // Fixed mahsulotlar ro'yxati
  async getFixedProducts(branchId?: number) {
    const where: Prisma.ProductWhereInput = {
      status: 'FIXED',
    };

    if (branchId) {
      where.branchId = branchId;
    }

    const products = await this.prisma.product.findMany({
      where,
      include: {
        category: true,
        branch: true,
      },
      orderBy: { id: 'asc' },
    });

    // Convert prices to som for display
    const productsWithSomPrices = await Promise.all(
      products.map(async (product) => {
        const priceInSom = await this.currencyExchangeRateService.convertCurrency(
          product.price,
          'USD',
          'UZS',
          product.branchId,
        );
        return {
          ...product,
          priceInSom,
          priceInDollar: product.price,
        };
      }),
    );

    return productsWithSomPrices;
  }

async remove(id: number, userId: number) {
  return this.prisma.$transaction(async (tx) => {
    const product = await tx.product.findUnique({ where: { id } });
    if (!product) {
      throw new NotFoundException('Mahsulot topilmadi');
    }

    // ✅ to‘g‘ri – tx dan foydalanamiz
    const deletedProduct = await tx.product.delete({
      where: { id },
    });

    return deletedProduct;
  });
}


  async uploadExcel(file: Express.Multer.File, fromBranchId: number, categoryId: number, status: string, userId: number) {
    try {
      const workbook = XLSX.read(file.buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const data: { [key: string]: any }[] = XLSX.utils.sheet_to_json(worksheet);

return this.prisma.$transaction(async (tx) => {
  for (const row of data) {
    let barcode = row['barcode'] ? String(row['barcode']) : null;
    if (!barcode) {
      barcode = await this.generateUniqueBarcode(tx);
    }

    const createProductDto: CreateProductDto = {
      barcode: barcode,
      name: String(row['name'] || ''),
      quantity: Number(row['quantity']) || 0,
      price: Number(row['price']) || 0,
      marketPrice: row['marketPrice'] ? Number(row['marketPrice']) : undefined,
      model: row['model'] ? String(row['model']) : undefined,
      months: row['months'] ? String(row['months']) : undefined,
      unitType: row['unitType'] ? String(row['unitType']) : undefined,
      description: row['description'] ? String(row['description']) : undefined,
      branchId: fromBranchId,
      categoryId: categoryId,
      status: (status || 'IN_STORE') as ProductStatus,
      bonusPercentage: row['bonusPercentage'] ? Number(row['bonusPercentage']) : 0,
    };

    const existing = await tx.product.findUnique({
      where: {
        barcode_branchId: {
          barcode,
          branchId: fromBranchId,
        },
      },
    });

    if (existing) {
      const newQuantity = existing.quantity + createProductDto.quantity;
      const updateDto: UpdateProductDto = {
        ...createProductDto,
        quantity: newQuantity,
      };
      await this.update(existing.id, updateDto, userId, tx); // ✅ tx uzatyapmiz
    } else {
      await this.create(createProductDto, userId, tx); // ✅ tx uzatyapmiz
    }
  }

  return { message: 'Mahsulotlar muvaffaqiyatli yuklandi' };
});

    } catch (error) {
      throw new BadRequestException('Excel faylini o\'qishda xatolik: ' + error.message);
    }
  }

  async removeMany(ids: number[]) {
    const products = await this.prisma.product.findMany({
      where: { id: { in: ids } },
    });

    if (products.length !== ids.length) {
      throw new NotFoundException("Ba'zi mahsulotlar topilmadi");
    }

    const deleted = await this.prisma.product.deleteMany({
      where: { id: { in: ids } },
    });
    return {
      message: "Mahsulotlar muvaffaqiyatli o'chirildi",
      count: deleted.count,
    };
  }

  async getPriceInSom(productId: number, branchId?: number) {
    const product = branchId 
      ? await this.findOneByBranch(productId, branchId)
      : await this.findOne(productId);
      
    if (!product) return null;

    return {
      priceInDollar: product.price,
      priceInSom: product.priceInSom,
    };
  }

  async getPriceInDollar(productId: number, branchId?: number) {
    const product = branchId 
      ? await this.findOneByBranch(productId, branchId)
      : await this.findOne(productId);
      
    if (!product) return null;

    return {
      priceInDollar: product.price,
      priceInSom: product.priceInSom,
    };
  }
}