import { Body, Controller, Get, Header, HttpCode, HttpStatus,
  Inject, Param, Post, UseGuards } from '@nestjs/common';
import {
  ApiBody, ApiHeader, ApiOkResponse, ApiOperation, ApiTags,
} from '@nestjs/swagger';
import { TradingApiService } from './trading-api.service.js';
import { TradingApiAdminGuard } from './trading-api-admin.guard.js';

@ApiTags('Internal - Trading Diagnostics')
@Controller('internal/trading')
@UseGuards(TradingApiAdminGuard)
@ApiHeader({name: 'x-trading-read-key', required: true, description: 'Independent 32+ character internal read key'})
export class TradingApiAdminController {
  constructor(@Inject(TradingApiService) private readonly trading: TradingApiService) {}

  @Header('Cache-Control', 'no-store')
  @Get('matches/:matchId/workflow')
  @ApiOperation({summary: 'Read-only trade and journal inspection for simulated/non-login users'})
  @ApiOkResponse({description: 'Sanitized B14/B16/B17 operation status; no encrypted signed transactions'})
  workflow(@Param('matchId') matchId: string) {
    return this.trading.internalWorkflow(matchId);
  }

  @Header('Cache-Control', 'no-store')
  @Post('matches/:matchId/preflight')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({summary: 'Policy-only preview; NEVER authorizes, signs, enqueues or sends blockchain actions'})
  @ApiBody({schema: {type: 'object', additionalProperties: false, required:['operation'],
    properties: {operation: {type:'string', enum:['CANCEL','EXPIRE','REFUND','ORACLE_CONFIRM','DB_RECONCILE']}}}})
  @ApiOkResponse({description: 'Candidate state only; CLI must perform independent on-chain preflight'})
  preflight(@Param('matchId') matchId: string, @Body() body: unknown) {
    return this.trading.internalPreflight(matchId, body);
  }
}
