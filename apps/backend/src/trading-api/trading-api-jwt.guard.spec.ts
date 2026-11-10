import { describe, expect, it, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { TradingApiJwtGuard } from './trading-api-jwt.guard.js';

const context = {} as ExecutionContext;

describe('B18 JWT delegation (AuthModule-owned guard)', () => {
  it('delegates the exact context and successful result', async () => {
    const canActivate = vi.fn().mockResolvedValue(true);
    const guard = new TradingApiJwtGuard({ canActivate } as unknown as JwtAuthGuard);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(canActivate).toHaveBeenCalledTimes(1);
    expect(canActivate).toHaveBeenCalledWith(context);
  });

  it('does not convert a rejected token to success', async () => {
    const refusal = new UnauthorizedException('Invalid or expired access token');
    const canActivate = vi.fn().mockRejectedValue(refusal);
    const guard = new TradingApiJwtGuard({ canActivate } as unknown as JwtAuthGuard);
    await expect(guard.canActivate(context)).rejects.toBe(refusal);
    expect(canActivate).toHaveBeenCalledTimes(1);
    expect(canActivate).toHaveBeenCalledWith(context);
  });

  it('does not turn a failed guard into authorization', async () => {
    const canActivate = vi.fn().mockResolvedValue(false);
    const guard = new TradingApiJwtGuard({ canActivate } as unknown as JwtAuthGuard);
    await expect(guard.canActivate(context)).resolves.toBe(false);
  });
});
