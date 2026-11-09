import { Inject, Injectable, ServiceUnavailableException, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createHederaContractReader,
  type HederaContractReader,
  type B13DeploymentStatus,
  type B13Trade,
  type B13ReceiptEvent,
} from '../../scripts/b13-contract-client.mjs';

/**
 * Read-only B13 gateway to deployed Hedera contracts.
 * No keys, signers, private-wallet access, transaction submission or public routes.
 * Exported to future trade/oracle modules only; B14 adds carefully guarded writes.
 */
@Injectable()
export class HederaContractsService implements OnModuleDestroy {
  private reader: HederaContractReader | null = null;

  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  private getReader(): HederaContractReader {
    if (this.reader) return this.reader;
    if (this.config.get<string>('HEDERA_NETWORK') !== 'testnet') {
      throw new ServiceUnavailableException('B13 is restricted to Hedera Testnet');
    }
    const rpcUrl = this.config.get<string>('HEDERA_TESTNET_RPC_URL');
    if (!rpcUrl) {
      throw new ServiceUnavailableException('Hedera Testnet read-only RPC is not configured');
    }
    try {
      this.reader = createHederaContractReader({ rpcUrl });
    } catch {
      throw new ServiceUnavailableException('Invalid Hedera Testnet read-only RPC configuration');
    }
    return this.reader;
  }

  async verifyDeployment(): Promise<B13DeploymentStatus> {
    return this.getReader().verifyDeployment();
  }

  async readTrade(onChainTradeId: string): Promise<B13Trade> {
    return this.getReader().getTrade(onChainTradeId);
  }

  async getOnChainTradeId(externalTradeId: string): Promise<string> {
    return this.getReader().getOnChainTradeId(externalTradeId);
  }

  async hasOperatorRole(operatorAddress: string): Promise<boolean> {
    return this.getReader().hasOperatorRole(operatorAddress);
  }

  async readReceiptEvents(txHash: string): Promise<{txHash: string; events: B13ReceiptEvent[]}> {
    return this.getReader().readReceiptEvents(txHash);
  }

  onModuleDestroy(): void {
    this.reader?.close();
    this.reader = null;
  }
}
