import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Inject,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { TradingApiAdminGuard } from '../trading-api/trading-api-admin.guard.js';
import { B26MarketRunsService } from './b26-market-runs.service.js';

@Controller('internal/v2/market-runs')
@UseGuards(TradingApiAdminGuard)
export class B26MarketRunsController {
  constructor(@Inject(B26MarketRunsService) private readonly runs: B26MarketRunsService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  list(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    if (
      !from ||
      !to ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/.test(from) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/.test(to)
    )
      throw new BadRequestException('Hour-aligned UTC from and to are required');
    const a = new Date(from),
      b = new Date(to);
    if (
      !Number.isFinite(a.getTime()) ||
      !Number.isFinite(b.getTime()) ||
      a.toISOString().replace('.000Z', 'Z') !== from ||
      b.toISOString().replace('.000Z', 'Z') !== to ||
      b.getTime() <= a.getTime() ||
      b.getTime() - a.getTime() > 31 * 86400000
    )
      throw new BadRequestException('Invalid time range');
    if (limit !== undefined && !/^(?:[1-9]|[1-9]\d|100)$/.test(limit))
      throw new BadRequestException('Invalid limit');
    if (offset !== undefined && (!/^(?:0|[1-9]\d{0,4})$/.test(offset) || Number(offset) > 10000))
      throw new BadRequestException('Invalid offset');
    return this.runs.list(a, b, Number(limit ?? 50), Number(offset ?? 0));
  }
  @Get('health')
  @Header('Cache-Control', 'no-store')
  health() {
    return this.runs.health();
  }
  @Get(':id')
  @Header('Cache-Control', 'no-store')
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.runs.get(id);
  }
}
