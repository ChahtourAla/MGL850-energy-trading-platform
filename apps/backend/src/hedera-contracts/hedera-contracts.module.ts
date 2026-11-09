import { Module } from '@nestjs/common';
import { HederaContractsService } from './hedera-contracts.service.js';

@Module({
  providers: [HederaContractsService],
  exports: [HederaContractsService],
})
export class HederaContractsModule {}
