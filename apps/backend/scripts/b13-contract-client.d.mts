export interface B13DeploymentStatus {
  network: 'hedera-testnet'; chainId: 296;
  tokenAddress: string; escrowAddress: string; tokenDecimals: 6;
  tokenSymbol: string; escrowPaused: boolean; nextTradeId: string;
  confirmedBytecode: true; paymentTokenMatches: true;
}
export interface B13Trade {
  onChainTradeId: string; externalTradeId: string; buyer: string; seller: string;
  quantityWh: string; unitPriceMicrousdPerKwh: string; totalAmountMicrousd: string;
  deliveryStart: string; deliveryDeadline: string; deliveredWh: string;
  evidenceHash: string; statusCode: number; status: string;
}
export interface B13ReceiptEvent {
  contract: string; event: string; signature: string;
  args: Record<string, unknown>; logIndex: number | null;
}
export declare class HederaContractReader {
  constructor(options: { rpcUrl: string });
  verifyDeployment(): Promise<B13DeploymentStatus>;
  getTrade(tradeId: string | number | bigint): Promise<B13Trade>;
  getOnChainTradeId(externalTradeId: string): Promise<string>;
  hasOperatorRole(address: string): Promise<boolean>;
  readReceiptEvents(txHash: string): Promise<{txHash: string; events: B13ReceiptEvent[]}>;
  close(): void;
}
export declare function createHederaContractReader(options: { rpcUrl: string }): HederaContractReader;
