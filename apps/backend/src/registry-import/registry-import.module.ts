import { Module } from '@nestjs/common';
import { ContractsModule } from '../contracts/contracts.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { InternalImportGuard } from './internal-import.guard.js';
import { RegistryImportController } from './registry-import.controller.js';
import { RegistryImportService } from './registry-import.service.js';

@Module({
  imports: [ContractsModule, PrismaModule],
  controllers: [RegistryImportController],
  providers: [RegistryImportService, InternalImportGuard],
})
export class RegistryImportModule {}
