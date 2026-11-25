/** Deterministic projection of per-household authoritative V2 trade responses. */
export type Household = { userId: string; name: string };
export type HouseholdTrade = {
  allocationId: string;
  intervalStart: string;
  marketId: string;
  side: 'BOUGHT' | 'SOLD';
  counterparty: { name: string };
  quantityWh: string;
  expectedPaymentBaseUnits: string;
  paymentStatus: string;
  network: string;
};
export type HouseholdResult = { userId: string; trades: HouseholdTrade[]; hasMore: boolean; failed: boolean };
export type OverviewRow = { ownerId: string; buyerName: string; sellerName: string; trade: HouseholdTrade };
export function buildHouseholdOverview(users: Household[], results: HouseholdResult[]) {
  const resultByUser = new Map(results.map(r => [r.userId, r]));
  const unique = new Map<string, OverviewRow>();
  const householdStates = users.map(user => {
    const response = resultByUser.get(user.userId);
    if (!response || response.failed) return { ...user, status: 'UNAVAILABLE', matches: null as number | null };
    for (const trade of response.trades) {
      if (!/^[a-zA-Z0-9._:-]{1,66}$/.test(trade.allocationId) || !['BOUGHT','SOLD'].includes(trade.side)) continue;
      const buyerName = trade.side === 'BOUGHT' ? user.name : trade.counterparty.name;
      const sellerName = trade.side === 'SOLD' ? user.name : trade.counterparty.name;
      // Prefer buyer's view for consistent presentation and proof ownership.
      if (!unique.has(trade.allocationId) || trade.side === 'BOUGHT') {
        unique.set(trade.allocationId,{ownerId:user.userId,buyerName,sellerName,trade});
      }
    }
    return {...user, status: response.hasMore ? 'PARTIAL' : response.trades.length ? 'MATCHED' : 'NO_MATCH', matches: response.trades.length};
  });
  return {householdStates, trades: [...unique.values()].sort((a,b)=>a.trade.allocationId.localeCompare(b.trade.allocationId)), complete: householdStates.every(h=>!['UNAVAILABLE','PARTIAL'].includes(h.status))};
}
