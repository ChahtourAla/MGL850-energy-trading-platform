export type WalletPublicStatus =
  | 'NOT_PROVISIONED'
  | 'PROVISIONING'
  | 'NEEDS_RECONCILIATION'
  | 'READY';

export interface PublicWallet {
  status: WalletPublicStatus;
  hederaAccountId?: string;
  evmAddress?: string;
}

export interface PreparedHederaWallet {
  // This private key must never be returned by an HTTP endpoint or logged.
  privateKey: string;
  publicKey: string;
  evmAddress: string;
  transactionId: string;
}

export interface WalletCreationReceipt {
  hederaAccountId: string;
}
