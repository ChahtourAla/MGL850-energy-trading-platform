import { Module } from '@nestjs/common';
import { ContractsModule } from '../contracts/contracts.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { InternalImportGuard } from '../registry-import/internal-import.guard.js';
import { EnergyImportController } from './energy-import.controller.js';
import { EnergyImportService } from './energy-import.service.js';

@Module({
  imports: [ContractsModule, PrismaModule],
  controllers: [EnergyImportController],
  providers: [EnergyImportService, InternalImportGuard],
})
export class EnergyImportModule {}
