import { Body, Controller, HttpCode, HttpStatus, Inject, Post, UseGuards } from '@nestjs/common';
import { ApiBody, ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InternalImportGuard } from './internal-import.guard.js';
import { RegistryImportService, type ImportResult } from './registry-import.service.js';

@ApiTags('Internal - User Registry')
@Controller('internal/users')
@UseGuards(InternalImportGuard)
export class RegistryImportController {
  constructor(@Inject(RegistryImportService) private readonly importer: RegistryImportService) {}

  @Post('import')
  @HttpCode(HttpStatus.OK)
  @ApiHeader({ name: 'x-internal-api-key', required: true, description: 'Internal service credential (never a user JWT)' })
  @ApiBody({ description: 'Canonical UserRegistry JSON from packages/shared/schemas/user-registry.schema.json', schema: { type: 'object' } })
  @ApiOperation({ summary: 'Atomically import or re-import simulated household profiles' })
  @ApiOkResponse({ description: 'Created, updated, unchanged and preserved registered user counts' })
  import(@Body() registry: unknown): Promise<ImportResult> {
    return this.importer.importRegistry(registry);
  }
}
