import { Module } from '@nestjs/common';
import { ContractValidator } from './contract-validator.js';

@Module({
  providers: [ContractValidator],
  exports: [ContractValidator],
})
export class ContractsModule {}
