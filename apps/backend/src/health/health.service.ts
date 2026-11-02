import { Inject, Injectable } from '@nestjs/common';

import { DatabaseService, type DatabaseStatus } from '../database/database.service.js';

export interface HealthReport {
  service: string;
  status: 'ok';
  timestamp: string;
  dependencies: {
    database: DatabaseStatus;
    blockchain: 'not_configured';
  };
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(DatabaseService)
    private readonly databaseService: DatabaseService,
  ) {}

  async getHealth(): Promise<HealthReport> {
    const database = await this.databaseService.checkConnection();

    return {
      service: 'p2p-energy-backend',
      status: 'ok',
      timestamp: new Date().toISOString(),
      dependencies: {
        database,
        blockchain: 'not_configured',
      },
    };
  }
}
