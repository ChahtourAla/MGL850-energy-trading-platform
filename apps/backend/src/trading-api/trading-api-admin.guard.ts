import { timingSafeEqual } from 'node:crypto';
import { CanActivate, ExecutionContext, ForbiddenException, Inject,
  Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

/** Independent, server-to-server READ-ONLY trading diagnostics credential. */
@Injectable()
export class TradingApiAdminGuard implements CanActivate {
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('TRADING_API_READ_ADMIN_KEY');
    if (!expected || expected.length < 32 || /[\r\n]/.test(expected)) {
      throw new ServiceUnavailableException('Trading diagnostics are not configured');
    }
    const header = context.switchToHttp().getRequest<Request>().headers['x-trading-read-key'];
    if (typeof header !== 'string' || /[\r\n]/.test(header)) {
      throw new ForbiddenException('Internal trading authorization required');
    }
    const supplied = Buffer.from(header, 'utf8');
    const reference = Buffer.from(expected, 'utf8');
    if (supplied.length !== reference.length || !timingSafeEqual(supplied, reference)) {
      throw new ForbiddenException('Internal trading authorization required');
    }
    return true;
  }
}
