import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { HederaContractsService } from '../hedera-contracts/hedera-contracts.service.js';
import { TradingApiService } from './trading-api.service.js';

const buyer = '11111111-1111-4111-8111-111111111111';
const seller = '22222222-2222-4222-8222-222222222222';
const outsider = '33333333-3333-4333-8333-333333333333';
const matchId = '44444444-4444-4444-8444-444444444444';
const tradeId = '55555555-5555-4555-8555-555555555555';
const match = { id: matchId, buyerId: buyer, sellerId: seller, status: 'SELECTED' };
const trade = { id: tradeId, matchId, buyerId: buyer, sellerId: seller,
  onChainTradeId: '2', status: 'AWAITING_DELIVERY', quantityWh: 2188n,
  totalAmountMicrousd: 250232n, externalTradeId: '0x' + 'a'.repeat(64) };
const a = '0x' + '1'.repeat(40), b = '0x' + '2'.repeat(40);
const chainTrade = { onChainTradeId: '2', externalTradeId: trade.externalTradeId,
  buyer: a, seller: b, quantityWh: '2188', unitPriceMicrousdPerKwh: '114366',
  totalAmountMicrousd: '250232', deliveryStart: '1794366000', deliveryDeadline: '1794369600',
  deliveredWh: '0', evidenceHash: '0x' + '0'.repeat(64), status: 'AWAITING_DELIVERY' };
function setup() {
  const client = {
    match: {findUnique: vi.fn().mockResolvedValue(match), findMany: vi.fn().mockResolvedValue([match])},
    trade: {findUnique: vi.fn().mockResolvedValue(trade), findMany: vi.fn().mockResolvedValue([trade])},
    deliveryRecord: {findUnique: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([])},
    b14TransactionIntent: {findMany: vi.fn().mockResolvedValue([{operation:'FUND_TRADE',status:'CONFIRMED',txHash:'0x123',signedTxCiphertext:'SECRET'}])},
    b16OracleIntent: {findUnique: vi.fn().mockResolvedValue(null)},
    b17OperatorIntent: {findMany: vi.fn().mockResolvedValue([])},
    wallet: {findUnique: vi.fn().mockImplementation(({where}: {where: {userId: string}}) =>
      Promise.resolve({evmAddress: where.userId === buyer ? a : b}))},
  };
  const hedera = {
    readTrade: vi.fn().mockResolvedValue(chainTrade),
    verifyDeployment: vi.fn().mockResolvedValue({chainId: 296, confirmedBytecode:true,paymentTokenMatches:true,escrowAddress:'0x'+'c'.repeat(40)}),
  };
  const sut = new TradingApiService({client} as unknown as PrismaService, hedera as unknown as HederaContractsService);
  return {sut,client,hedera};
}

describe('B18 authenticated privacy boundary', () => {
  it('buyer sees match, amounts are exact JSON strings', async () => {
    const {sut}=setup();
    expect((await sut.getMatch(buyer, matchId)).id).toBe(matchId);
  });
  it('outsider receives 404 and not another user’s matching data', async () => {
    const {sut}=setup();
    await expect(sut.getMatch(outsider,matchId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(sut.getTrade(outsider,tradeId)).rejects.toBeInstanceOf(NotFoundException);
  });
  it('non-UUID queries fail without DB lookup', async () => {
    const {sut,client}=setup();
    await expect(sut.getTrade(buyer,'../../etc/passwd')).rejects.toBeInstanceOf(BadRequestException);
    expect(client.trade.findUnique).not.toHaveBeenCalled();
  });
  it('listing trades enforces actor filter and source match check', async () => {
    const {sut,client}=setup();
    const page = await sut.listTrades(buyer);
    expect(page.items[0].totalAmountMicrousd).toBe('250232');
    expect(client.trade.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {OR: [{buyerId: buyer},{sellerId: buyer}]},
    }));
  });
  it('tampered source buyer rejects paginated trade output', async () => {
    const {sut,client}=setup();
    client.match.findMany.mockResolvedValue([{...match,buyerId:outsider}]);
    await expect(sut.listTrades(buyer)).rejects.toBeInstanceOf(ConflictException);
  });
  it('matched trade owned by other user cannot serve payment hashes', async () => {
    const {sut,client}=setup();
    await expect(sut.getPaymentHistory(outsider,tradeId)).rejects.toBeInstanceOf(NotFoundException);
    expect(client.b14TransactionIntent.findMany).not.toHaveBeenCalled();
  });
  it('sanitizes encrypted journal material', async () => {
    const {sut}=setup();
    const payment=await sut.getPaymentHistory(buyer,tradeId);
    expect(JSON.stringify(payment)).not.toContain('SECRET');
    expect(payment.funding[0].txHash).toBe('0x123');
  });
  it('other user cannot access delivery records', async () => {
    const {sut,client}=setup();
    await expect(sut.getDeliveries(outsider,tradeId)).rejects.toBeInstanceOf(NotFoundException);
    expect(client.deliveryRecord.findMany).not.toHaveBeenCalled();
  });
  it('live read rejects mismatched B07 owner wallet', async () => {
    const {sut,client}=setup();
    client.wallet.findUnique.mockResolvedValue({evmAddress:'0x'+'f'.repeat(40)});
    await expect(sut.getOnChainTrade(buyer,tradeId)).rejects.toBeInstanceOf(ConflictException);
  });
  it('live read rejects wrong chain amount', async () => {
    const {sut,hedera}=setup();
    hedera.readTrade.mockResolvedValue({...chainTrade,totalAmountMicrousd:'2'});
    await expect(sut.getOnChainTrade(buyer,tradeId)).rejects.toBeInstanceOf(ConflictException);
  });
  it('live read rejects mismatched escrow deployment', async () => {
    const {sut, client}=setup();
    client.trade.findUnique.mockResolvedValue({...trade,contractAddress:'0x'+'d'.repeat(40)});
    await expect(sut.getOnChainTrade(buyer,tradeId)).rejects.toBeInstanceOf(ConflictException);
  });
  it('live read accepts canonical chain data with public status', async () => {
    const {sut}=setup();
    expect((await sut.getOnChainTrade(buyer,tradeId)).statusAligned).toBe(true);
  });
  it('internal policy preview never sends chain transaction or writes DB', async () => {
    const {sut,client,hedera}=setup();
    const r=await sut.internalPreflight(matchId,{operation:'ORACLE_CONFIRM'});
    expect(r.executionAuthorized).toBe(false);
    expect(r.blockchainWriteRequested).toBe(false);
    expect(hedera.readTrade).toHaveBeenCalledOnce();
    for(const db of Object.values(client)) {
      expect((db as Record<string, unknown>).create).toBeUndefined();
      expect((db as Record<string, unknown>).update).toBeUndefined();
    }
  });
});
