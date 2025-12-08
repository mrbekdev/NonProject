import { Module } from '@nestjs/common';
import { TransactionService } from './transaction.service';
import { TransactionController } from './transaction.controller';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrencyExchangeRateModule } from '../currency-exchange-rate/currency-exchange-rate.module';

import { TaskModule } from '../task/task.module';

@Module({
  imports: [CurrencyExchangeRateModule, TaskModule],
  controllers: [TransactionController],
  providers: [TransactionService, PrismaService],
})
export class TransactionModule {}
