import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';

import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';

import { HealthService, type HealthReport } from './health.service.js';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    @Inject(HealthService)
    private readonly healthService: HealthService,
  ) {}

  /**
   * HTTP liveness endpoint.
   *
   * Always returns HTTP 200 while the API is running,
   * even if the database is temporarily unavailable.
   */
  @Get()
  @ApiOperation({
    summary: 'Check backend liveness',
    description: 'Reports the running backend and observed dependency states.',
  })
  @ApiOkResponse({
    description: 'The HTTP application is running.',
  })
  async getHealth(): Promise<HealthReport> {
    return this.healthService.getHealth();
  }

  /**
   * Database readiness endpoint for B03.
   *
   * In later steps, this will also validate other
   * required operational dependencies.
   */
  @Get('ready')
  @ApiOperation({
    summary: 'Check backend database readiness',
  })
  @ApiOkResponse({
    description: 'PostgreSQL is reachable.',
  })
  @ApiServiceUnavailableResponse({
    description: 'PostgreSQL is unavailable or not configured.',
  })
  async getReadiness(): Promise<HealthReport> {
    const report = await this.healthService.getHealth();

    if (report.dependencies.database !== 'connected') {
      throw new ServiceUnavailableException('PostgreSQL is not ready');
    }

    return report;
  }
}
