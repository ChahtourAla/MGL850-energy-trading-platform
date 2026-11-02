import { Injectable } from '@nestjs/common';

export interface BackendInfo {
  service: string;
  status: string;
  message: string;
  version: string;
}

/**
 * Basic application information service.
 *
 * This is only a bootstrap endpoint.
 * Real health/readiness checks will be added in B02.
 */
@Injectable()
export class AppService {
  getInfo(): BackendInfo {
    return {
      service: 'p2p-energy-backend',
      status: 'ok',
      message: 'MGL850 P2P Energy Trading Backend is running',
      version: '0.1.0',
    };
  }
}
