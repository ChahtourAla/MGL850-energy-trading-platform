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

@Injectable()
export class InternalImportGuard implements CanActivate {
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('INTERNAL_IMPORT_API_KEY');
    if (!expected || expected.length < 32) {
      throw new ServiceUnavailableException('Internal registry import is not configured');
    }
    const request = context.switchToHttp().getRequest<Request>();
    const supplied = request.headers['x-internal-api-key'];
    if (typeof supplied !== 'string') {
      throw new ForbiddenException('Internal authorization required');
    }
    const a = Buffer.from(supplied, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new ForbiddenException('Internal authorization required');
    }
    return true;
  }
}
