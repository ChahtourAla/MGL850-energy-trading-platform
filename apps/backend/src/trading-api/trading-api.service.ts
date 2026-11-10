import {
  BadRequestException, ConflictException, Inject, Injectable,
  NotFoundException, ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { HederaContractsService } from '../hedera-contracts/hedera-contracts.service.js';
import {
  assertUuid, parsePage, hasParticipant, checkTradeSource, publicMatch,
  publicTrade, publicDelivery, publicIntent, paginate, verifyOnChainLink,
  parsePreflightBody, previewOperation,
} from '../../scripts/b18-api-core.mjs';

/**
 * Authenticated read model over the B12–B17 canonical PostgreSQL records.
 * NO private wallet access, signing, process spawning or writes.
 */
@Injectable()
export class TradingApiService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(HederaContractsService) private readonly chain: HederaContractsService,
  ) {}

  private uuid(input: unknown, label: string): string {
    try { return assertUuid(input, label); }
    catch { throw new BadRequestException(`${label} must be a UUID`); }
  }

  private page(limit?: unknown, cursor?: unknown): {limit: number; cursor?: string} {
    try { return parsePage(limit, cursor); }
    catch { throw new BadRequestException('Use limit=1..50 and an optional UUID cursor'); }
  }

  private async findMatch(matchId: string, actorId?: string) {
    const match = await this.prisma.client.match.findUnique({where: {id: matchId}});
    if (!match || (actorId && !hasParticipant(match, actorId))) {
      // Identical 404 hides the existence of other participants' trades.
      throw new NotFoundException('Match not found');
    }
    return match;
  }

  private async findTrade(tradeId: string, actorId?: string) {
    const trade = await this.prisma.client.trade.findUnique({where: {id: tradeId}});
    if (!trade) throw new NotFoundException('Trade not found');
    const match = await this.findMatch(trade.matchId, actorId);
    try { checkTradeSource(trade, match); }
    catch { throw new ConflictException('Trade does not match its source match'); }
    return {trade, match};
  }

  private async tradeFromMatch(matchId: string, actorId?: string) {
    const match = await this.findMatch(matchId, actorId);
    const trade = await this.prisma.client.trade.findUnique({where: {matchId}});
    if (trade) {
      try { checkTradeSource(trade, match); }
      catch { throw new ConflictException('Trade does not match its source match'); }
    }
    return {trade, match};
  }

  async listMatches(actorId: string, limit?: unknown, cursor?: unknown) {
    const pg = this.page(limit, cursor);
    if (pg.cursor) {
      const checkpoint = await this.prisma.client.match.findUnique({where: {id: pg.cursor}});
      if (!hasParticipant(checkpoint, actorId)) throw new BadRequestException('Invalid cursor');
    }
    const rows = await this.prisma.client.match.findMany({
      where: {OR: [{buyerId: actorId}, {sellerId: actorId}]},
      orderBy: {id: 'asc'}, take: pg.limit + 1,
      ...(pg.cursor ? {skip: 1, cursor: {id: pg.cursor}} : {}),
    });
    return paginate(rows, pg.limit, publicMatch);
  }

  async getMatch(actorId: string, matchId: string) {
    return publicMatch(await this.findMatch(this.uuid(matchId, 'matchId'), actorId));
  }

  async listTrades(actorId: string, limit?: unknown, cursor?: unknown) {
    const pg = this.page(limit, cursor);
    if (pg.cursor) {
      try { await this.findTrade(pg.cursor, actorId); }
      catch { throw new BadRequestException('Invalid cursor'); }
    }
    // Filtering at the DB, then verifying source match protects the data boundary.
    const rows = await this.prisma.client.trade.findMany({
      where: {OR: [{buyerId: actorId}, {sellerId: actorId}]},
      orderBy: {id: 'asc'}, take: pg.limit + 1,
      ...(pg.cursor ? {skip: 1, cursor: {id: pg.cursor}} : {}),
    });
    const matches = await this.prisma.client.match.findMany({
      where: {id: {in: rows.map(row => row.matchId)}},
    });
    const byId = new Map(matches.map(row => [row.id, row]));
    for (const trade of rows) {
      const match = byId.get(trade.matchId);
      if (!hasParticipant(match, actorId)) {
        throw new ConflictException('Trade ownership is inconsistent with its source match');
      }
      try { checkTradeSource(trade, match); }
      catch { throw new ConflictException('Trade ownership is inconsistent with its source match'); }
    }
    return paginate(rows, pg.limit, publicTrade);
  }

  async getTrade(actorId: string, tradeId: string) {
    return publicTrade((await this.findTrade(this.uuid(tradeId, 'tradeId'), actorId)).trade);
  }

  async getDeliveries(actorId: string, tradeId: string, limit?: unknown, cursor?: unknown) {
    const {trade} = await this.findTrade(this.uuid(tradeId, 'tradeId'), actorId);
    const pg = this.page(limit, cursor);
    if (pg.cursor) {
      const item = await this.prisma.client.deliveryRecord.findUnique({where: {id: pg.cursor}});
      if (!item || item.tradeId !== trade.id) throw new BadRequestException('Invalid cursor');
    }
    const rows = await this.prisma.client.deliveryRecord.findMany({
      where: {tradeId: trade.id}, orderBy: {id: 'asc'}, take: pg.limit + 1,
      ...(pg.cursor ? {skip: 1, cursor: {id: pg.cursor}} : {}),
    });
    return paginate(rows, pg.limit, publicDelivery);
  }

  private async journals(matchId: string) {
    const [funding, oracle, operator] = await Promise.all([
      this.prisma.client.b14TransactionIntent.findMany({where: {matchId}, orderBy: {createdAt: 'asc'}}),
      this.prisma.client.b16OracleIntent.findUnique({where: {matchId}}),
      this.prisma.client.b17OperatorIntent.findMany({where: {matchId}, orderBy: {createdAt: 'asc'}}),
    ]);
    return {
      funding: funding.map(item => publicIntent(item, 'FUNDING')),
      oracle: oracle ? publicIntent(oracle, 'ORACLE') : null,
      recovery: operator.map(item => publicIntent(item, 'RECOVERY')),
    };
  }

  async getPaymentHistory(actorId: string, tradeId: string) {
    const {trade} = await this.findTrade(this.uuid(tradeId, 'tradeId'), actorId);
    return {tradeId: trade.id, matchId: trade.matchId, ...await this.journals(trade.matchId)};
  }

  private async readChain(trade: unknown, match: {buyerId: string; sellerId: string}) {
    const candidate = trade as {onChainTradeId?: unknown} | null;
    if (!candidate || (typeof candidate.onChainTradeId !== 'string' &&
        typeof candidate.onChainTradeId !== 'bigint')) {
      throw new ConflictException('Trade has no on-chain identifier');
    }
    let chain;
    let deployment;
    try {
      [chain, deployment] = await Promise.all([
        this.chain.readTrade(String(candidate.onChainTradeId)),
        this.chain.verifyDeployment(),
      ]);
    } catch { throw new ServiceUnavailableException('Hedera read-only RPC or deployment verification unavailable'); }
    try {
      const verified = verifyOnChainLink(trade, chain);
      const stored = trade as {contractAddress?: string | null};
      if (deployment.chainId !== 296 || !deployment.confirmedBytecode ||
          !deployment.paymentTokenMatches ||
          (stored.contractAddress && stored.contractAddress.toLowerCase() !== deployment.escrowAddress.toLowerCase())) {
        throw new Error('Untrusted escrow deployment');
      }
      // B07 wallet ownership is authoritative even when Trade has no wallet columns.
      const [buyerWallet, sellerWallet] = await Promise.all([
        this.prisma.client.wallet.findUnique({where: {userId: match.buyerId}}),
        this.prisma.client.wallet.findUnique({where: {userId: match.sellerId}}),
      ]);
      if (!buyerWallet?.evmAddress || !sellerWallet?.evmAddress ||
          buyerWallet.evmAddress.toLowerCase() !== chain.buyer.toLowerCase() ||
          sellerWallet.evmAddress.toLowerCase() !== chain.seller.toLowerCase()) {
        throw new Error('Wallet owner mismatch');
      }
      return verified;
    } catch { throw new ConflictException('On-chain trade does not match stored identity, wallets or amounts'); }
  }

  async getOnChainTrade(actorId: string, tradeId: string) {
    const {trade, match} = await this.findTrade(this.uuid(tradeId, 'tradeId'), actorId);
    return this.readChain(trade, match);
  }

  // Separate, non-JWT service credential is required by the internal controller.
  async internalWorkflow(matchId: string) {
    const id = this.uuid(matchId, 'matchId');
    const {match, trade} = await this.tradeFromMatch(id);
    return {
      match: publicMatch(match),
      trade: trade ? publicTrade(trade) : null,
      journals: await this.journals(id),
    };
  }

  /** Read-only candidate preview. NEVER signs, enqueues, executes or synchronizes. */
  async internalPreflight(matchId: string, body: unknown) {
    let operation;
    try { ({operation} = parsePreflightBody(body)); }
    catch { throw new BadRequestException('Expected {operation: CANCEL | EXPIRE | REFUND | ORACLE_CONFIRM | DB_RECONCILE}'); }
    const id = this.uuid(matchId, 'matchId');
    const {trade, match} = await this.tradeFromMatch(id);
    if (!trade) throw new ConflictException('There is no persisted Trade to inspect');
    const [onchain, journals] = await Promise.all([this.readChain(trade, match), this.journals(id)]);
    const expire = journals.recovery.find(row => row.operation === 'EXPIRE');
    const preview = previewOperation({
      operation,
      chainStatus: onchain.onChainStatus,
      dbStatus: trade.status,
      deadline: Date.parse(onchain.deliveryDeadline) / 1000,
      b16Status: journals.oracle?.status == null ? null : String(journals.oracle.status),
      expireStatus: expire?.status == null ? null : String(expire.status),
    });
    return {matchId: id, tradeId: trade.id, ...preview};
  }
}
