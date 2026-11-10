export declare function assertUuid(value: unknown, name?: string): string;
export declare function parsePage(limit?: unknown, cursor?: unknown): {limit: number; cursor?: string};
export declare function hasParticipant(match: {buyerId:string; sellerId:string} | null | undefined, userId: string): boolean;
export declare function checkTradeSource(trade: {matchId:string; buyerId:string; sellerId:string} | null | undefined, match: {id:string;buyerId:string;sellerId:string} | null | undefined): boolean;
export declare function valueToWire(value: unknown): string | number | boolean | null;
export declare function publicMatch(row: unknown): Record<string, string | number | boolean | null>;
export declare function publicTrade(row: unknown): Record<string, string | number | boolean | null>;
export declare function publicDelivery(row: unknown): Record<string, string | number | boolean | null>;
export declare function publicIntent(row: unknown, phase: string): Record<string, string | number | boolean | null>;
export declare function paginate<T>(rows: T[], limit: number, projector: (row: T) => Record<string, string | number | boolean | null>): {
  items: Record<string, string | number | boolean | null>[];
  nextCursor: string | null;
  limit: number;
};
export declare function verifyOnChainLink(db: unknown, chain: unknown): {
  onChainTradeId:string; chainId:296; onChainStatus:string; databaseStatus:string;
  statusAligned:boolean; quantityWh:string; totalAmountMicrousd:string; deliveredWh:string;
  evidenceHash:string; deliveryStart:string; deliveryDeadline:string;
};
export declare function parsePreflightBody(body: unknown): {operation:'CANCEL'|'EXPIRE'|'REFUND'|'ORACLE_CONFIRM'|'DB_RECONCILE'};
export declare function previewOperation(input: {
  operation:'CANCEL'|'EXPIRE'|'REFUND'|'ORACLE_CONFIRM'|'DB_RECONCILE';
  chainStatus:string; dbStatus:string; deadline?:string|number|null;
  b16Status?:string|null; expireStatus?:string|null; now?:number;
}): {operation:string;kind:'READ_ONLY_POLICY_PREVIEW';candidate:boolean;blockers:string[];executionAuthorized:false;blockchainWriteRequested:false;note:string};
