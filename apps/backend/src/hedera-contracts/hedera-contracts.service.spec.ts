import { describe, expect, it } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { HederaContractsService } from './hedera-contracts.service.js';

function service(env: Record<string, string | undefined>): HederaContractsService {
  return new HederaContractsService({ get: (name: string) => env[name] } as never);
}

describe('B13 HederaContractsService safety gates', () => {
  it('rejects all networks other than explicit Testnet', async () => {
    await expect(service({ HEDERA_NETWORK: 'mainnet', HEDERA_TESTNET_RPC_URL: 'https://example.org' }).verifyDeployment())
      .rejects.toBeInstanceOf(ServiceUnavailableException);
  });
  it('fails closed without RPC configuration', async () => {
    await expect(service({ HEDERA_NETWORK: 'testnet' }).verifyDeployment())
      .rejects.toBeInstanceOf(ServiceUnavailableException);
  });
  it('rejects insecure public RPC URL', async () => {
    await expect(service({ HEDERA_NETWORK: 'testnet', HEDERA_TESTNET_RPC_URL: 'http://example.org' }).verifyDeployment())
      .rejects.toBeInstanceOf(ServiceUnavailableException);
  });
  it('allows shutdown without opening a network connection', () => {
    expect(() => service({}).onModuleDestroy()).not.toThrow();
  });
});
