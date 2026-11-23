/**
 * Read-only exploratory report on historical B12 matches.
 * Does NOT change legacy amounts, reinterpret matches as V2, or grant authorization.
 * From repo root: node --env-file=apps/backend/.env apps/backend/scripts/b28-pricing-impact.mjs
 */
import {quoteTeusd, B28_POLICY} from './b28-teusd-quantization.mjs';

if (process.argv.length !== 2) {
  console.error('STOP: This report accepts no command-line arguments.');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('STOP: Missing DATABASE_URL in backend environment.');
  process.exit(1);
}
const {default:pg} = await import('../node_modules/pg/lib/index.js');
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
  statement_timeout: 15000,
  query_timeout: 20000,
  application_name: 'mgl850-b28-pricing-impact-READ-ONLY',
});
let begun=false;
try {
  await client.connect();
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  begun=true;
  const identity=(await client.query(`SELECT current_database() AS database, current_user AS actor, current_setting('transaction_read_only') AS readonly`)).rows[0];
  if(identity.database!=='energy_trading'||identity.readonly!=='on')throw new Error('Refusing non-main database or writable transaction');
  const {rows}=await client.query(`SELECT id,time_slot,quantity_wh,unit_price_microusd_per_kwh,total_amount_microusd FROM matches ORDER BY time_slot,id`);
  let nonExact=0, legacyMismatch=0, increasedFromFloor=0;
  let sumExactNumerator=0n, sumRounded=0n, sumRecorded=0n;
  const report=[];
  for(const match of rows){
    const quote=quoteTeusd({quantityWh:String(match.quantity_wh),unitPriceMicrousdPerKwh:String(match.unit_price_microusd_per_kwh)});
    const recorded=BigInt(String(match.total_amount_microusd));
    if(recorded<0n)throw new Error('Negative legacy amount');
    const floor=BigInt(quote.legacyFloorBaseUnits);
    const rounded=BigInt(quote.amountBaseUnits);
    if(!quote.exactPayment)nonExact++;
    if(recorded!==floor)legacyMismatch++;
    if(quote.roundedUpFromFloor)increasedFromFloor++;
    sumRounded+=rounded;
    sumRecorded+=recorded;
    sumExactNumerator+=BigInt(quote.numeratorWhTimesPrice);
    report.push({
      utcHour:new Date(match.time_slot).toISOString().replace('.000Z','Z'),
      matchId:String(match.id).slice(0,8),
      remainder:quote.remainderOf1000,
      recordedB12:recorded.toString(),
      halfEvenProposal:rounded.toString(),
      deltaVersusRecorded:(rounded-recorded).toString(),
      b12MatchesFloor:recorded===floor,
    });
  }
  console.log('=== B28 PRICING POLICY IMPACT — READ ONLY / NOT AN AUTHORIZATION ===');
  console.log(`Database: ${identity.database} | Actor: ${identity.actor} | READ ONLY: ${identity.readonly} | Policy prototype: ${B28_POLICY}`);
  console.table(report);
  console.log(JSON.stringify({
    totalHistoricalMatches:rows.length,
    nonExactHistoricalMatches:nonExact,
    recordedB12NotEqualToExactRationalFloor:legacyMismatch,
    proposedAmountsGreaterThanTruncation:increasedFromFloor,
    recordedB12TotalBaseUnits:sumRecorded.toString(),
    proposedHalfEvenTotalBaseUnits:sumRounded.toString(),
    netProposalMinusRecordedBaseUnits:(sumRounded-sumRecorded).toString(),
    cumulativeRoundingErrorNumeratorOf1000BaseUnits:(sumRounded*1000n-sumExactNumerator).toString(),
    warning:'Proposals are not historical payments or authoritative V2 allocations. No persistence or blockchain calls.'
  },null,2));
  if(legacyMismatch>0)console.warn('WARNING: B12 recorded amounts differ from floor formula; investigate before integrating any pricing policy.');
  console.log('PASS: Read-only impact report completed. No database writes, approvals, or transactions.');
}catch(error){
  console.error('B28 PRICING IMPACT STOP:',error?.message??String(error));
  process.exitCode=1;
}finally{
  if(begun)await client.query('ROLLBACK').catch(()=>{});
  await client.end().catch(()=>{});
}
