export function uint(v: string): bigint;
export function marketId(namespace: string, mode: string, start: string, end: string): string;
export function snapshotHash(market: string, participants: {userId: string; productionWh: string; consumptionWh: string}[]): string;
export function allocationId(market: string, snapshot: string, buyer: string, seller: string, buyerAddress: string, sellerAddress: string, quantity: string, price: string, algorithm: string, pricing: string, plan: string): string;
export function paymentParts(quantity: string, price: string): {amountBaseUnits: string; remainder: number};
export function validatePosition<T extends Record<string, string>>(position: T): T;
export function intentId(allocation: string, chainId: string, token: string): string;
/** Versioned economic input commitment; immutable persistence and binding remain unimplemented. */
export function matchingInputHash(manifest: Record<string, unknown>): string;
