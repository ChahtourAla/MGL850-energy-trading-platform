import { Controller, Get, Inject } from '@nestjs/common';

import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { HealthService, type HealthReport } from './health.service.js';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    @Inject(HealthService)
    private readonly healthService: HealthService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Check backend liveness',
    description:
      'Checks that the HTTP application is running. ' +
      'Database and blockchain are not yet configured.',
  })
  @ApiOkResponse({
    description: 'The backend process is running.',
  })
  getHealth(): HealthReport {
    return this.healthService.getHealth();
  }
}
