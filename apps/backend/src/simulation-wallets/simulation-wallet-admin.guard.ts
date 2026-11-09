import { timingSafeEqual } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

/** Separate authority for spending testnet HBAR; never reuse the B08 import key. */
@Injectable()
export class SimulationWalletAdminGuard implements CanActivate {
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('SIMULATION_WALLET_ADMIN_KEY');
    if (!expected || expected.length < 32) {
      throw new ServiceUnavailableException('Simulation wallet administration is not configured');
    }
    const supplied = context.switchToHttp().getRequest<Request>().headers['x-simulation-wallet-key'];
    if (typeof supplied !== 'string') {
      throw new ForbiddenException('Simulation wallet authorization required');
    }
    const a = Buffer.from(supplied, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new ForbiddenException('Simulation wallet authorization required');
    }
    return true;
  }
}
