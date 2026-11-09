import { Body, Controller, HttpCode, HttpStatus, Inject, Post, UseGuards } from '@nestjs/common';
import { ApiBody, ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InternalImportGuard } from '../registry-import/internal-import.guard.js';
import { EnergyImportService, type EnergyImportResult } from './energy-import.service.js';

@ApiTags('Internal - Energy Snapshots')
@Controller('internal/energy')
@UseGuards(InternalImportGuard)
export class EnergyImportController {
  constructor(@Inject(EnergyImportService) private readonly importer: EnergyImportService) {}

  @Post('import')
  @HttpCode(HttpStatus.OK)
  @ApiHeader({ name: 'x-internal-api-key', required: true, description: 'Internal service credential; never a user JWT' })
  @ApiBody({ description: 'Canonical EnergySnapshot JSON (packages/shared/schemas/energy-snapshot.schema.json)', schema: { type: 'object' } })
  @ApiOperation({ summary: 'Atomically import a wallet-verified hourly energy snapshot' })
  @ApiOkResponse({ description: 'Created or unchanged hourly energy records' })
  import(@Body() snapshot: unknown): Promise<EnergyImportResult> {
    return this.importer.importSnapshot(snapshot);
  }
}
