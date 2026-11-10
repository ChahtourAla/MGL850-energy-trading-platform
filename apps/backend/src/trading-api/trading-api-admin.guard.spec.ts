import { describe, expect, it } from 'vitest';
import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { TradingApiAdminGuard } from './trading-api-admin.guard.js';

const key='a-unique-trading-READ-ONLY-key-that-is-over-32-characters';
function context(value?: string): ExecutionContext {
  return {switchToHttp: () => ({getRequest: () => ({headers: {'x-trading-read-key':value}})})} as unknown as ExecutionContext;
}
function guard(secret?: string) {
  return new TradingApiAdminGuard({get: () => secret} as unknown as ConfigService);
}

describe('B18 internal read-only administration boundary',()=>{
  it('rejects missing environment key',()=>expect(()=>guard().canActivate(context(key))).toThrow(ServiceUnavailableException));
  it('rejects short environment key',()=>expect(()=>guard('short').canActivate(context('short'))).toThrow(ServiceUnavailableException));
  it('rejects missing supplied header',()=>expect(()=>guard(key).canActivate(context())).toThrow(ForbiddenException));
  it('rejects other key',()=>expect(()=>guard(key).canActivate(context(key+'-bad'))).toThrow(ForbiddenException));
  it('rejects CRLF header',()=>expect(()=>guard(key).canActivate(context(key+'\n'))).toThrow(ForbiddenException));
  it('accepts equal independent key',()=>expect(guard(key).canActivate(context(key))).toBe(true));
});
