import { Inject, Injectable, ServiceUnavailableException, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AccountCreateTransaction,
  AccountId,
  Client,
  Hbar,
  PrivateKey,
  PublicKey,
  TransactionId,
  TransactionReceiptQuery,
} from '@hiero-ledger/sdk';
import type { PreparedHederaWallet, WalletCreationReceipt } from './wallet.types.js';

/** Real network operations are isolated here so API tests never spend testnet HBAR. */
@Injectable()
export class HederaWalletGateway implements OnModuleDestroy {
  private client: Client | null = null;

  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  private getClient(): Client {
    if (this.client) return this.client;
    if (this.config.get<string>('HEDERA_NETWORK') !== 'testnet') {
      throw new ServiceUnavailableException('Wallet creation supports Testnet only');
    }
    const operatorId = this.config.get<string>('HEDERA_OPERATOR_ID');
    const operatorKey = this.config.get<string>('HEDERA_OPERATOR_KEY');
    if (!operatorId || !operatorKey) {
      throw new ServiceUnavailableException('Hedera Testnet operator is not configured');
    }
    const client = Client.forTestnet();
    client.setOperator(AccountId.fromString(operatorId), PrivateKey.fromString(operatorKey));
    this.client = client;
    return client;
  }

  prepare(): PreparedHederaWallet {
    // Fail before staging a key if the operator's credentials are invalid.
    this.getClient();
    const operatorId = this.config.get<string>('HEDERA_OPERATOR_ID');
    if (!operatorId || this.config.get<string>('HEDERA_NETWORK') !== 'testnet') {
      throw new ServiceUnavailableException('Hedera Testnet operator is not configured');
    }
    const privateKey = PrivateKey.generateECDSA();
    const alias = privateKey.publicKey.toEvmAddress();
    if (!alias) throw new Error('Generated Hedera key is not ECDSA secp256k1');
    const evmHex = alias.toString().replace(/^0x/i, '').toLowerCase();
    return {
      privateKey: privateKey.toString(),
      publicKey: privateKey.publicKey.toString(),
      evmAddress: `0x${evmHex}`,
      // Persist before broadcast. SDK must NOT generate a new ID on retry.
      transactionId: TransactionId.generate(AccountId.fromString(operatorId)).toString(),
    };
  }

  async submit(prepared: Pick<PreparedHederaWallet, 'publicKey' | 'transactionId'>): Promise<WalletCreationReceipt> {
    const client = this.getClient();
    const publicKey = PublicKey.fromString(prepared.publicKey);
    const alias = publicKey.toEvmAddress();
    if (!alias) throw new Error('Wallet public key must be ECDSA secp256k1');
    const transaction = new AccountCreateTransaction()
      .setKey(publicKey)
      .setAlias(alias)
      .setInitialBalance(new Hbar(0))
      .setTransactionId(TransactionId.fromString(prepared.transactionId));
    const response = await transaction.execute(client);
    const receipt = await response.getReceipt(client);
    if (!receipt.accountId) {
      throw new Error('Hedera account-creation receipt did not include an account ID');
    }
    return { hederaAccountId: receipt.accountId.toString() };
  }

  async findCreatedAccount(transactionId: string, evmAddress: string): Promise<string | null> {
    // First query the consensus receipt. Recent transactions are available here.
    try {
      const receipt = await new TransactionReceiptQuery()
        .setTransactionId(TransactionId.fromString(transactionId))
        .execute(this.getClient());
      if (receipt.accountId) return receipt.accountId.toString();
    } catch {
      // A receipt may be expired or temporarily unavailable; mirror-node
      // lookup by the key-derived EVM alias can recover older accounts.
    }

    // Fixed Testnet endpoint: user input is a validated, locally derived
    // 0x-prefixed 20-byte EVM address, not an arbitrary URL.
    if (!/^0x[0-9a-fA-F]{40}$/.test(evmAddress)) {
      throw new Error('Invalid EVM address in wallet provisioning record');
    }
    const response = await fetch(
      `https://testnet.mirrornode.hedera.com/api/v1/accounts/${evmAddress}`,
      { signal: AbortSignal.timeout(7000) },
    );
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('Testnet mirror node is unavailable');
    const data: unknown = await response.json();
    if (typeof data !== 'object' || data === null) return null;
    const record = data as { account?: unknown; evm_address?: unknown; deleted?: unknown };
    if (
      typeof record.account !== 'string' ||
      !/^\d+\.\d+\.\d+$/.test(record.account) ||
      typeof record.evm_address !== 'string' ||
      record.evm_address.toLowerCase() !== evmAddress.toLowerCase() ||
      record.deleted === true
    ) {
      return null;
    }
    return record.account;
  }

  onModuleDestroy(): void {
    this.client?.close();
    this.client = null;
  }
}
