import { BadRequestException, Controller, Get, Header, Inject, Query, UseGuards } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { TradingApiAdminGuard } from '../trading-api/trading-api-admin.guard.js';
import { aggregateCoverage, classifyHour, isoDay } from './b34-hour-core.js';

/** Read-only UTC-day coverage. Recorded evidence is NOT independent chain verification. */
@Controller('internal/v2/demo')
@UseGuards(TradingApiAdminGuard)
export class B34FullDayController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get('day-coverage')
  @Header('Cache-Control', 'no-store')
  async dayCoverage(@Query('day') day?: string) {
    let start: Date;
    try { start = isoDay(day); } catch { throw new BadRequestException('Valid UTC day=YYYY-MM-DD required'); }
    const end = new Date(start.getTime() + 86400000);
    const db = this.prisma.client;
    const [users, energy, runs, matches, markets, allocations, b26] = await Promise.all([
      db.user.findMany({ where: { accountOrigin: 'SIMULATED' }, select: { id: true }, take: 200 }),
      db.energyRecord.findMany({
        where: { timeSlot: { gte: start, lt: end }, snapshotImport: { isNot: null }, user: { accountOrigin: 'SIMULATED' } },
        select: { userId: true, timeSlot: true, marketRole: true }, take: 10000,
      }),
      db.matchingRun.findMany({ where: { timeSlot: { gte: start, lt: end } }, select: { timeSlot: true, matchCount: true }, take: 200 }),
      db.match.findMany({ where: { timeSlot: { gte: start, lt: end } }, select: { timeSlot: true, id: true }, take: 10000 }),
      db.v2Market.findMany({ where: { namespace: 'hourly', mode: 'HOURLY', intervalStart: { gte: start, lt: end } }, select: { intervalStart: true, id: true, status: true }, take: 200 }),
      db.v2Allocation.findMany({
        where: { status: 'VALIDATED', plan: { status: 'AUTHORITATIVE' }, market: { namespace: 'hourly', mode: 'HOURLY', intervalStart: { gte: start, lt: end } } },
        select: {
          id: true, marketId: true, buyerAddress: true, sellerAddress: true, amountBaseUnits: true,
          market: { select: { intervalStart: true } },
          intent: { select: { chainId: true, status: true, tokenAddress: true, contractAddress: true, amountBaseUnits: true,
            evidence: { select: { chainId: true, receiptStatus: true, verificationStatus: true, txHash: true,
              contractAddress: true, tokenAddress: true, buyerAddress: true, sellerAddress: true, amountBaseUnits: true } } } },
        },
        take: 10000,
      }),
      db.b26MarketRun.findMany({ where: { intervalStart: { gte: start, lt: end } }, select: { intervalStart: true, configuration: true, status: true, failureCode: true }, take: 1000 }),
    ]);
    const known = new Set(users.map(x => x.id));
    const equal=(a: string | null | undefined,b: string | null | undefined)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
    const expectedContract=process.env.B27_EXPECTED_SETTLEMENT_ADDRESS;
    const expectedToken=process.env.B27_EXPECTED_TEUSD_ADDRESS ?? process.env.TEST_ENERGY_USD_ADDRESS;
    const hours=Array.from({length:24},(_,h)=>{
      const slot=new Date(start.getTime()+h*3600000).toISOString();
      const records=energy.filter(x=>x.timeSlot.toISOString()===slot&&known.has(x.userId));
      const validUsers=new Set(records.map(x=>x.userId));
      const matching=runs.filter(x=>x.timeSlot.toISOString()===slot);
      const historical=matches.filter(x=>x.timeSlot.toISOString()===slot);
      const marketRows=markets.filter(x=>x.intervalStart.toISOString()===slot);
      const v2=allocations.filter(x=>x.market.intervalStart.toISOString()===slot);
      const b26Rows=b26.filter(x=>x.intervalStart.toISOString()===slot);
      const verifiedRecord=v2.filter(x=>{
        const i=x.intent, ev=i?.evidence;
        if(!i||i.status!=='CONFIRMED'||i.chainId!==296||i.amountBaseUnits!==x.amountBaseUnits||!expectedContract||!expectedToken||!equal(i.contractAddress,expectedContract)||!equal(i.tokenAddress,expectedToken)||ev?.length!==1)return false;
        const e=ev?.[0];if(!e)return false;return e.chainId===296&&e.receiptStatus==='SUCCESS'&&e.verificationStatus==='VERIFIED'&&
          /^0x[0-9a-fA-F]{64}$/.test(e.txHash)&&equal(e.contractAddress,expectedContract)&&equal(e.tokenAddress,expectedToken)&&
          equal(e.buyerAddress,x.buyerAddress)&&equal(e.sellerAddress,x.sellerAddress)&&e.amountBaseUnits===x.amountBaseUnits;
      });
      const stats={measurements:validUsers.size,expectedHouseholds:users.length,b12Runs:matching.length,b12Matches:historical.length,v2Allocations:v2.length,recordedProofs:verifiedRecord.length};
      return {
        hourUTC:slot, ...stats,
        matchedBuyerCount:records.filter(x=>x.marketRole==='BUYER').length,
        matchedSellerCount:records.filter(x=>x.marketRole==='SELLER').length,
        b12ReportedMatchCount:matching.reduce((n,x)=>n+x.matchCount,0),
        b26Runs:b26Rows.map(x=>({configuration:x.configuration,status:x.status,failureCode:x.failureCode})),
        v2MarketStatuses:marketRows.map(x=>x.status),
        recordedTeusdBaseUnits:verifiedRecord.reduce((s,x)=>s+x.amountBaseUnits,0n).toString(),
        state:classifyHour(stats),
      };
    });
    const summary=aggregateCoverage(hours);
    return {
      simulationOnly:true,readOnly:true,utcDay:start.toISOString().slice(0,10),expectedHouseholds:users.length,
      summary,hours,
      evidenceLevel:'DATABASE_RECORDED_ONLY',
      note:'Recorded proofs are consistency checks in PostgreSQL, NOT fresh independent Hedera verification. Inspect individual on-chain verification links or run B34 independent chain audit.',
    };
  }
}
