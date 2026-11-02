import { Injectable } from '@nestjs/common';

export interface HealthReport {
  service: string;
  status: 'ok';
  timestamp: string;
  dependencies: {
    database: 'not_configured';
    blockchain: 'not_configured';
  };
}

@Injectable()
export class HealthService {
  getHealth(): HealthReport {
    return {
      service: 'p2p-energy-backend',
      status: 'ok',
      timestamp: new Date().toISOString(),
      dependencies: {
        database: 'not_configured',
        blockchain: 'not_configured',
      },
    };
  }
}
