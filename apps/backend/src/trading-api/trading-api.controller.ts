import {
  Controller, Get, Header, Inject, Param, Query, Req,
  UnauthorizedException, UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth, ApiOkResponse, ApiOperation, ApiParam, ApiQuery, ApiTags,
} from '@nestjs/swagger';
import { TradingApiJwtGuard } from './trading-api-jwt.guard.js';
import type { AuthenticatedRequest } from '../auth/auth.types.js';
import { TradingApiService } from './trading-api.service.js';

@ApiTags('Trading')
@ApiBearerAuth()
@UseGuards(TradingApiJwtGuard)
@Controller('trading')
export class TradingApiController {
  constructor(@Inject(TradingApiService) private readonly trading: TradingApiService) {}

  private actor(req: AuthenticatedRequest): string {
    if (!req.authenticatedUser) throw new UnauthorizedException('Authentication required');
    return req.authenticatedUser.id;
  }

  @Header('Cache-Control', 'private, no-store')
  @Get('matches')
  @ApiOperation({summary: 'List matches belonging to the authenticated buyer or seller'})
  @ApiQuery({name: 'limit', required: false, description: 'Page size 1–50; default 20'})
  @ApiQuery({name: 'cursor', required: false, description: 'UUID returned as nextCursor'})
  @ApiOkResponse({description: 'Public match fields only; amounts encoded without JSON precision loss'})
  listMatches(@Req() req: AuthenticatedRequest, @Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    return this.trading.listMatches(this.actor(req), limit, cursor);
  }

  @Header('Cache-Control', 'private, no-store')
  @Get('matches/:matchId')
  @ApiParam({name: 'matchId', description: 'Match UUID'})
  @ApiOperation({summary: 'Read a match; returns 404 for other users’ matches'})
  getMatch(@Req() req: AuthenticatedRequest, @Param('matchId') matchId: string) {
    return this.trading.getMatch(this.actor(req), matchId);
  }

  @Header('Cache-Control', 'private, no-store')
  @Get('trades')
  @ApiOperation({summary: 'List authenticated participant trades'})
  @ApiQuery({name: 'limit', required: false})
  @ApiQuery({name: 'cursor', required: false})
  @ApiOkResponse({description: 'Paginated, secret-free trades'})
  listTrades(@Req() req: AuthenticatedRequest, @Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    return this.trading.listTrades(this.actor(req), limit, cursor);
  }

  @Header('Cache-Control', 'private, no-store')
  @Get('trades/:tradeId')
  @ApiOperation({summary: 'Read one trade, with buyer/seller ownership enforcement'})
  getTrade(@Req() req: AuthenticatedRequest, @Param('tradeId') tradeId: string) {
    return this.trading.getTrade(this.actor(req), tradeId);
  }

  @Header('Cache-Control', 'private, no-store')
  @Get('trades/:tradeId/deliveries')
  @ApiQuery({name: 'limit', required: false})
  @ApiQuery({name: 'cursor', required: false})
  @ApiOperation({summary: 'View recorded delivery results; never publishes raw oracle evidence'})
  getDeliveries(@Req() req: AuthenticatedRequest, @Param('tradeId') tradeId: string,
    @Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    return this.trading.getDeliveries(this.actor(req), tradeId, limit, cursor);
  }

  @Header('Cache-Control', 'private, no-store')
  @Get('trades/:tradeId/payments')
  @ApiOperation({summary: 'View sanitized B14/B16/B17 transaction and payout statuses'})
  getPayments(@Req() req: AuthenticatedRequest, @Param('tradeId') tradeId: string) {
    return this.trading.getPaymentHistory(this.actor(req), tradeId);
  }

  @Header('Cache-Control', 'private, no-store')
  @Get('trades/:tradeId/chain')
  @ApiOperation({summary: 'Verify stored trade identity and amount against Hedera Testnet (read-only)'})
  getChain(@Req() req: AuthenticatedRequest, @Param('tradeId') tradeId: string) {
    return this.trading.getOnChainTrade(this.actor(req), tradeId);
  }
}
