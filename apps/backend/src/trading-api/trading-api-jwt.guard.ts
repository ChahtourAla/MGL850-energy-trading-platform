import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';

/**
 * Nest resolves controller guards in the controller's module. Directly using
 * JwtAuthGuard here constructs another instance without its JwtService/UsersService
 * dependencies. Delegate to the singleton JwtAuthGuard exported by AuthModule.
 * This is not a new authentication implementation and never bypasses JWT checks.
 */
@Injectable()
export class TradingApiJwtGuard implements CanActivate {
  constructor(@Inject(JwtAuthGuard) private readonly existingAuth: JwtAuthGuard) {}

  canActivate(context: ExecutionContext): Promise<boolean> {
    return this.existingAuth.canActivate(context);
  }
}
