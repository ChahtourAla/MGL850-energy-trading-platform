/** B34 independent full-day audit: read-only SQL transaction + Hedera Testnet RPC.
 * No signing, no token approval, no broadcast, no PostgreSQL writes.
 * Usage: node --env-file=.env --env-file=apps/backend/.env apps/backend/scripts/b34-independent-audit.mjs --day=2026-11-10
 */
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir,homedir} from 'node:os';
import {AbiCoder,Contract,Interface,getAddress,keccak256} from '../../../packages/contracts/node_modules/ethers/lib.esm/index.js';
import {TOKEN,CHAIN_ID,PRICING,quoteHalfEven} from './b28-hedera-core.mjs';
import {SETTLEMENT_ABI,TOKEN_ABI,policyId,algorithmId,authorizationDigest,recoverBuyer,rpc} from './b28-hedera-runtime.mjs';
import {isoDay,classifyHour,aggregateCoverage,ledgerFlows} from './b34-hour-core.mjs';
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const regexHash=/^0x[0-9a-fA-F]{64}$/,regexAddress=/^0x[0-9a-fA-F]{40}$/;
function args(argv){if(argv.length!==1||!/^--day=\d{4}-\d{2}-\d{2}$/.test(argv[0]))throw Error('Usage: --day=YYYY-MM-DD');const day=argv[0].slice(6);isoDay(day);return day;}
function dbAddress(){const str=process.env.DATABASE_URL;if(!str)throw Error('DATABASE_URL is missing');const u=new URL(str);
 if(!['postgres:','postgresql:'].includes(u.protocol)||!['localhost','127.0.0.1','[::1]'].includes(u.hostname)||u.pathname!=='/energy_trading'||decodeURIComponent(u.username)!=='energy_admin')throw Error('Only local energy_trading database / energy_admin is accepted');return str;}
function hashPlan(m,ids){if(!regexHash.test(m.id)||!regexHash.test(m.snapshotHash)||!regexHash.test(m.manifestHash)||ids.length===0||new Set(ids).size!==ids.length)throw Error('Invalid market commitment inputs');
 return keccak256(AbiCoder.defaultAbiCoder().encode(['string','bytes32','bytes32','bytes32','bytes32[]'],['mgl850:b28:half-even-plan:1',m.id,m.snapshotHash,m.manifestHash,ids.map(x=>x.toLowerCase()).sort()]));}
const settlementIface=new Interface(SETTLEMENT_ABI),tokenIface=new Interface(TOKEN_ABI);
async function readState(day){
 const {default:pg}=await import('../node_modules/pg/lib/index.js');
 const client=new pg.Client({connectionString:dbAddress(),connectionTimeoutMillis:5000,query_timeout:30000,statement_timeout:25000,application_name:'mgl850-b34-read-only-audit'});
 const start=isoDay(day),end=new Date(start.getTime()+86400000);let tx=false;
 try{await client.connect();await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');tx=true;
 const mode=(await client.query("SELECT current_database() AS db, current_setting('transaction_read_only') AS ro, session_user AS actor")).rows[0];
 if(mode.db!=='energy_trading'||mode.ro!=='on'||mode.actor!=='energy_admin')throw Error('Database read-only guard failed');
 const p=[start,end];
 const users=(await client.query("SELECT u.id AS \"userId\",u.name,w.evm_address AS address FROM users u LEFT JOIN wallets w ON w.user_id=u.id WHERE u.account_origin='SIMULATED' ORDER BY u.name,u.id")).rows;
 const energy=(await client.query('SELECT er.time_slot AS slot, er.user_id AS "userId", er.market_role AS role FROM energy_records er JOIN energy_snapshot_imports si ON si.id=er.snapshot_id JOIN users u ON u.id=er.user_id AND u.account_origin=\'SIMULATED\' WHERE er.time_slot >=$1 AND er.time_slot <$2',[...p])).rows;
 const runs=(await client.query('SELECT time_slot AS slot, match_count AS "matchCount" FROM matching_runs WHERE time_slot >=$1 AND time_slot <$2',p)).rows;
 const matches=(await client.query('SELECT time_slot AS slot, id FROM matches WHERE time_slot >=$1 AND time_slot <$2',p)).rows;
 const b26=(await client.query('SELECT "intervalStart" AS slot, status, configuration, "failureCode" FROM "B26MarketRun" WHERE "intervalStart">=$1 AND "intervalStart"<$2',p)).rows;
 const markets=(await client.query('SELECT m.id,m."intervalStart" AS slot,m.status FROM "V2Market" m WHERE m.namespace=\'hourly\' AND m.mode=\'HOURLY\' AND m."intervalStart">=$1 AND m."intervalStart"<$2',p)).rows;
 const plans=(await client.query('SELECT p.id,p."marketId" AS "marketId",p."snapshotId" AS "snapshotId",p."manifestHash" AS "manifestHash",p.status,s."payloadHash" AS "snapshotHash",s.status AS "snapshotStatus" FROM "V2AllocationPlan" p JOIN "V2Snapshot" s ON s.id=p."snapshotId" WHERE p.status=\'AUTHORITATIVE\' AND p."marketId"=ANY($1::text[])',[markets.map(m=>m.id)])).rows;
 const allocations=(await client.query(`SELECT a.id,a."marketId",a."buyerId",a."sellerId",a."buyerAddress",a."sellerAddress",a."quantityWh"::text AS "quantityWh",a."unitPriceMicrousdPerKwh"::text AS "price",a."amountBaseUnits"::text AS "amountBaseUnits",a.remainder,a."planId",a."snapshotId",a.status,
 i.id AS "intentId",i.status AS "intentStatus",i."chainId" AS "intentChain",i."tokenAddress" AS "intentToken",i."contractAddress" AS "intentContract",i."amountBaseUnits"::text AS "intentAmount",
 e."txHash",e."chainId" AS "evidenceChain",e."receiptStatus",e."verificationStatus",e."contractAddress" AS "evidenceContract",e."tokenAddress" AS "evidenceToken",e."buyerAddress" AS "evidenceBuyer",e."sellerAddress" AS "evidenceSeller",e."amountBaseUnits"::text AS "evidenceAmount",e."blockReference",e."logIndex", 
 att."txHash" AS "attemptHash", att.status AS "attemptStatus"
 FROM "V2Allocation" a JOIN "V2Market" m ON m.id=a."marketId" AND m.namespace='hourly' AND m.mode='HOURLY'
 JOIN "V2AllocationPlan" ap ON ap.id=a."planId" AND ap."marketId"=a."marketId" AND ap.status='AUTHORITATIVE'
 LEFT JOIN "V2SettlementIntent" i ON i."allocationId"=a.id
 LEFT JOIN "V2SettlementEvidence" e ON e."settlementId"=i.id
 LEFT JOIN "V2SettlementAttempt" att ON att."settlementId"=i.id AND att."transactionIdentity"='B28_SETTLEMENT'
 WHERE a.status='VALIDATED' AND m."intervalStart">=$1 AND m."intervalStart"<$2 ORDER BY m."intervalStart",a.id`,p)).rows;
 const planMap=new Map(plans.map(x=>[x.marketId,x]));if(planMap.size!==plans.length)throw Error('Duplicate authoritative plans');
 const marketMap=new Map(markets.map(m=>[m.id,{...m,plan:planMap.get(m.id)}]));
 const seen=new Set();for(const a of allocations){if(seen.has(a.id))throw Error('Duplicate allocation/journal/evidence rows');seen.add(a.id);const m=marketMap.get(a.marketId);if(!m||m.status!=='MATCHED'||m.id!==a.marketId||!m.plan||a.planId!==m.plan.id||a.snapshotId!==m.plan.snapshotId)throw Error('Allocation missing authoritative plan linkage');}
 await client.query('ROLLBACK');tx=false;return {users,energy,runs,matches,b26,markets,plans,allocations};
 }finally{if(tx)await client.query('ROLLBACK').catch(()=>{});await client.end().catch(()=>{});}
}
function buildHours(day,s){const expected=s.users.length;const hours=[];
 for(let i=0;i<24;i++){
  const slot=`${day}T${String(i).padStart(2,'0')}:00:00.000Z`;
  const at=x=>x.slot?.toISOString()===slot;
  const energy=s.energy.filter(at),run=s.runs.filter(at),matches=s.matches.filter(at),v2Markets=s.markets.filter(at),b26=s.b26.filter(at);
  const alloc=s.allocations.filter(x=>v2Markets.some(m=>m.id===x.marketId));
  const recorded=alloc.filter(x=>x.intentStatus==='CONFIRMED'&&x.evidenceChain===296&&x.receiptStatus==='SUCCESS'&&x.verificationStatus==='VERIFIED'&&x.intentChain===296&&same(x.intentToken,TOKEN)&&same(x.evidenceToken,TOKEN)&&x.intentAmount===x.amountBaseUnits&&x.evidenceAmount===x.amountBaseUnits);
  const {size:measurements}=new Set(energy.map(x=>x.userId));
  const stats={measurements,expectedHouseholds:expected,b12Runs:run.length,b12Matches:matches.length,v2Allocations:alloc.length,recordedProofs:recorded.length};
  hours.push({hourUTC:slot,...stats,b12ReportedMatchCount:run.reduce((t,x)=>t+x.matchCount,0),potentialBuyers:energy.filter(x=>x.role==='BUYER').length,potentialSellers:energy.filter(x=>x.role==='SELLER').length,b26Runs:b26.map(x=>({status:x.status,configuration:x.configuration,failureCode:x.failureCode})),v2MarketStatuses:v2Markets.map(x=>x.status),state:classifyHour(stats),recordedTeusdBaseUnits:recorded.reduce((v,x)=>v+BigInt(x.amountBaseUnits),0n).toString()});
 }
 return hours;
}
function evidenceGuard(a,contract){return regexHash.test(a.id)&&regexHash.test(a.txHash??'')&&regexHash.test(a.intentId??'')&&a.intentStatus==='CONFIRMED'&&a.attemptStatus==='CONFIRMED'&&same(a.txHash,a.attemptHash)&&a.intentChain===296&&a.evidenceChain===296&&a.receiptStatus==='SUCCESS'&&a.verificationStatus==='VERIFIED'&&same(a.intentContract,contract)&&same(a.evidenceContract,contract)&&same(a.intentToken,TOKEN)&&same(a.evidenceToken,TOKEN)&&same(a.evidenceBuyer,a.buyerAddress)&&same(a.evidenceSeller,a.sellerAddress)&&a.intentAmount===a.amountBaseUnits&&a.evidenceAmount===a.amountBaseUnits;}
async function verifyOne(provider,settlement,market,a,contract,operator){
 if(!evidenceGuard(a,contract))throw Error('Database intent/receipt evidence mismatch');
 const q=quoteHalfEven(a.quantityWh,a.price);if(q.amountBaseUnits!==a.amountBaseUnits||q.remainder!==a.remainder)throw Error('Half-even repricing mismatch');
 const [tx,rc]=await Promise.all([provider.getTransaction(a.txHash),provider.getTransactionReceipt(a.txHash)]);
 if(!tx||!rc||rc.status!==1||!same(tx.hash,a.txHash)||!same(tx.from,operator)||!same(tx.to,contract)||!same(rc.to,contract)||BigInt(tx.value)!==0n)throw Error('Settlement transaction missing or wrong sender/recipient');
 const block=await provider.getBlock(rc.blockNumber);if(!block||!same(block.hash,rc.blockHash))throw Error('Noncanonical settlement block');
 const call=settlementIface.parseTransaction({data:tx.data,value:tx.value});if(!call||call.name!=='settle')throw Error('Transaction is not settle()');
 const term=call.args[0],signature=call.args[1];
 const checkString={token:TOKEN,marketId:a.marketId,snapshotHash:market.snapshotHash,planCommitment:market.commitment,allocationId:a.id,buyer:a.buyerAddress,seller:a.sellerAddress,algorithmId,pricingPolicyId:policyId};
 for(const [k,v] of Object.entries(checkString))if(!same(term[k],v))throw Error(`On-chain settlement field ${k} mismatch`);
 const checkUint={quantityWh:a.quantityWh,unitPriceMicrousdPerKwh:a.price,amountBaseUnits:a.amountBaseUnits};
 for(const [k,v] of Object.entries(checkUint))if(BigInt(term[k])!==BigInt(v))throw Error(`On-chain settlement amount ${k} mismatch`);
 const digest=authorizationDigest(term,contract);
 if(!same(digest,a.intentId)||!recoverBuyer(term,contract,signature))throw Error('Buyer EIP712 signature or intent digest mismatch');
 const settled=[],transfers=[];
 for(const l of rc.logs){if(same(l.address,contract)){try{const e=settlementIface.parseLog(l);if(e?.name==='EnergyPaymentSettled'&&same(e.args.settlementId,digest)&&same(e.args.marketId,a.marketId)&&same(e.args.allocationId,a.id)&&same(e.args.snapshotHash,market.snapshotHash)&&same(e.args.planCommitment,market.commitment)&&same(e.args.buyer,a.buyerAddress)&&same(e.args.seller,a.sellerAddress)&&same(e.args.token,TOKEN)&&BigInt(e.args.quantityWh)===BigInt(a.quantityWh)&&BigInt(e.args.unitPriceMicrousdPerKwh)===BigInt(a.price)&&BigInt(e.args.amountBaseUnits)===BigInt(a.amountBaseUnits)&&same(e.args.algorithmId,algorithmId)&&same(e.args.pricingPolicyId,policyId)&&BigInt(e.args.nonce)===BigInt(term.nonce))settled.push(l);}catch{}}
  if(same(l.address,TOKEN)){try{const e=tokenIface.parseLog(l);if(e?.name==='Transfer'&&same(e.args.from,a.buyerAddress)&&same(e.args.to,a.sellerAddress)&&BigInt(e.args.value)===BigInt(a.amountBaseUnits))transfers.push(l);}catch{}}
 }
 if(settled.length!==1||transfers.length!==1)throw Error('Expected exactly one matching energy payment and TEUSD transfer');
 if(a.logIndex!==settled[0].index)throw Error('Settlement event log index differs from database');
 if(a.blockReference&&!same(a.blockReference,rc.blockHash))throw Error('Database block reference differs');
 const [paid,executed,nonceUsed,chainPlan,chainSnapshot]=await Promise.all([settlement.paidAllocations(a.id),settlement.executedSettlements(digest),settlement.usedNonces(a.buyerAddress,term.nonce),settlement.marketPlans(a.marketId),settlement.marketSnapshots(a.marketId)]);
 if(!paid||!executed||!nonceUsed||!same(chainPlan,market.commitment)||!same(chainSnapshot,market.snapshotHash))throw Error('On-chain finality/replay state mismatch');
 return {transactionHash:a.txHash,blockNumber:rc.blockNumber,amountBaseUnits:a.amountBaseUnits};
}
async function main(){const day=args(process.argv.slice(2));const state=await readState(day);const hours=buildHours(day,state);const summary=aggregateCoverage(hours);
 const byMarket=new Map();for(const m of state.markets){const plan=state.plans.find(p=>p.marketId===m.id);if(!plan)continue;if(plan.snapshotStatus!=='FINALIZED'||!regexHash.test(plan.snapshotHash)||!regexHash.test(plan.manifestHash))throw Error('Invalid finalized market source');
  const entries=state.allocations.filter(a=>a.marketId===m.id);const commitment=hashPlan({...m,snapshotHash:plan.snapshotHash,manifestHash:plan.manifestHash},entries.map(x=>x.id));byMarket.set(m.id,{...m,planId:plan.id,snapshotHash:plan.snapshotHash,manifestHash:plan.manifestHash,commitment});}
 const report={mode:'B34_INDEPENDENT_FULL_DAY_READ_ONLY',utcDay:day,database:'energy_trading',summary,hours,households:[],transactions:[],problems:[],network:'NOT_VERIFIED',balanceBlock:null,notes:[
  'B12 no-run hours are NOT equivalent to no-match market outcomes.',
  'All historical B12 matches are separate from authoritative V2 allocations.',
  'A wallet balance cannot be derived from energy trade totals without verifying all funding and other ERC-20 transfers.',
  'No database writes, no signing, no approvals and no blockchain broadcasts.',
 ]};
 const append=(key,message)=>report.problems.push(`${key}: ${message}`);
 if(state.users.length!==12)append('HOUSEHOLDS',`expected 12, found ${state.users.length}`);
 for(const h of hours){if(h.measurements!==state.users.length)append('ENERGY',`${h.hourUTC} only ${h.measurements}/${state.users.length} readings`);
  if(h.b12Runs>0&&h.b12ReportedMatchCount!==h.b12Matches)append('B12_MATCHING',`${h.hourUTC} reported ${h.b12ReportedMatchCount} matches; stored ${h.b12Matches}`);
  if(h.b12Runs===0&&h.v2Allocations===0)append('COVERAGE',`${h.hourUTC} has no historical B12 matching run and no V2 allocations; potential buyers=${h.potentialBuyers}, sellers=${h.potentialSellers}`);
 }
 const seenTx=new Set(),seenMarket=new Set();for(const a of state.allocations){if(!byMarket.has(a.marketId))append('MARKET',`unverified plan for allocation ${a.id}`);if(seenMarket.has(a.id))append('ALLOC',`duplicated allocation ${a.id}`);seenMarket.add(a.id);if(a.txHash){if(seenTx.has(a.txHash))append('TX',`same transaction appears for multiple allocations ${a.txHash}`);seenTx.add(a.txHash);}}
 const flows=ledgerFlows(state.users.map(u=>({userId:u.userId,name:u.name,address:u.address})),state.allocations);
 let provider=null;let token=null;let settlement=null;let contract=null;
 try{
  const dpath=join(process.env.LOCALAPPDATA??join(homedir(),'.local','share'),'mgl850-b28-hedera','deployment.json');
  const deployed=JSON.parse(await readFile(dpath,'utf8'));
  contract=deployed.contract;
  if(deployed.state!=='CONFIRMED'||deployed.chainId!==296||!same(deployed.token,TOKEN)||!regexAddress.test(contract)||!regexAddress.test(deployed.operator)||!regexHash.test(deployed.codeHash)||!regexHash.test(deployed.deployHash))throw Error('Trusted B28 deployment journal unavailable/mismatched');
  provider=await rpc();if((await provider.getNetwork()).chainId!==BigInt(CHAIN_ID))throw Error('Wrong chain');
  const code=await provider.getCode(contract);if(code==='0x'||!same(keccak256(code),deployed.codeHash))throw Error('On-chain contract codeHash mismatch');
  settlement=new Contract(contract,SETTLEMENT_ABI,provider);token=new Contract(TOKEN,TOKEN_ABI,provider);
  const [ct,dec,sym]=await Promise.all([settlement.paymentToken(),token.decimals(),token.symbol()]);if(!same(ct,TOKEN)||Number(dec)!==6||sym!=='TEUSD')throw Error('Wrong TEUSD contract');
  report.network='HEDERA_TESTNET_RPC_VERIFIED';
  const pinned=await provider.getBlockNumber();report.balanceBlock=pinned;
  for(const f of flows){if(!regexAddress.test(f.address)){append('WALLET',`invalid household wallet: ${f.name}`);report.households.push({...f,onChainBalanceBaseUnits:null,balanceStatus:'NOT_VERIFIED'});continue;}
   try{const b=await token.balanceOf(f.address,{blockTag:pinned});report.households.push({...f,onChainBalanceBaseUnits:b.toString(),balanceStatus:'VERIFIED_ON_CHAIN',balanceBlock:pinned});}
   catch{append('BALANCE',`cannot verify balance for ${f.name}`);report.households.push({...f,onChainBalanceBaseUnits:null,balanceStatus:'NOT_VERIFIED'});}
  }
  for(const a of state.allocations){const m=byMarket.get(a.marketId);
    try{if(!m)throw Error('No finalized authoritative market plan');const receipt=await verifyOne(provider,settlement,m,a,contract,deployed.operator);report.transactions.push({hourUTC:m.slot.toISOString(),allocationId:a.id,buyerAddress:a.buyerAddress,sellerAddress:a.sellerAddress,amountBaseUnits:a.amountBaseUnits,verifyStatus:'VERIFIED_HEDERA_TEUSD_TRANSFER',...receipt});}
    catch(e){const message=String(e?.message??e);append('SETTLEMENT',`${a.id}: ${message.substring(0,140)}`);report.transactions.push({allocationId:a.id,amountBaseUnits:a.amountBaseUnits,verifyStatus:'NOT_VERIFIED',transactionHash:a.txHash??null});}
  }
 }catch(e){report.network='HEDERA_TESTNET_NOT_VERIFIED';append('CHAIN',String(e?.message??e).substring(0,140));for(const f of flows)if(!report.households.some(x=>x.userId===f.userId))report.households.push({...f,onChainBalanceBaseUnits:null,balanceStatus:'NOT_VERIFIED'});}
 report.summary.independentlyVerifiedTransfers=report.transactions.filter(x=>x.verifyStatus==='VERIFIED_HEDERA_TEUSD_TRANSFER').length;
 report.summary.householdBalancesVerified=report.households.filter(x=>x.balanceStatus==='VERIFIED_ON_CHAIN').length;
 report.summary.verifiedTransferBaseUnits=report.transactions.filter(x=>x.verifyStatus==='VERIFIED_HEDERA_TEUSD_TRANSFER').reduce((s,x)=>s+BigInt(x.amountBaseUnits),0n).toString();
 const targetDemo=day==='2026-11-10';report.summary.allAuthorizedSettlementsVerified=report.network==='HEDERA_TESTNET_RPC_VERIFIED'&&report.summary.importedHours===24&&(!targetDemo||(report.summary.v2Allocations===17&&report.summary.v2TradingHours===8))&&report.summary.independentlyVerifiedTransfers===report.summary.v2Allocations&&report.summary.householdBalancesVerified===12;
 report.summary.full24hMatchingCoverageVerified=hours.every(h=>h.b12Runs>0||h.v2Allocations>0);
 report.summary.completeAutonomousDayVerified=report.summary.allAuthorizedSettlementsVerified&&report.summary.full24hMatchingCoverageVerified;
 const out=join(tmpdir(),`MGL850_B34_${day}_READ_ONLY_REPORT.json`);await writeFile(out,JSON.stringify(report,null,2));
 console.log('=== B34 24-HOUR ENERGY/MATCHING COVERAGE ===');console.table(hours.map(h=>({hour:h.hourUTC.slice(11,16),readings:h.measurements,B12runs:h.b12Runs,B12matches:h.b12Matches,V2:h.v2Allocations,proofs:h.recordedProofs,buyers:h.potentialBuyers,sellers:h.potentialSellers,status:h.state})));
 console.log('=== B34 HOUSEHOLD TEUSD LEDGER AND LIVE BALANCES ===');console.table(report.households.map(h=>({household:h.name,trades:h.trades,spentTEUSD:h.spentBaseUnits,earnedTEUSD:h.earnedBaseUnits,netFlow:h.netTradeFlowBaseUnits,onChainBalance:h.onChainBalanceBaseUnits,balanceStatus:h.balanceStatus})));
 console.log('=== B34 VERIFIED CHAIN PAYMENTS ===');console.table(report.transactions.map(t=>({allocation:t.allocationId.slice(0,15),amount:t.amountBaseUnits,status:t.verifyStatus,tx:t.transactionHash})));
 console.log('SUMMARY',JSON.stringify(report.summary));console.log('NETWORK',report.network);console.log('FINDINGS',report.problems.length);for(const p of report.problems)console.log('NOTE:',p);
 console.log('REPORT:',out);console.log('READ ONLY: No database writes, token approvals, signing or blockchain broadcast.');
 if(!report.summary.allAuthorizedSettlementsVerified||report.problems.some(x=>!x.startsWith('COVERAGE:'))) {console.error('B34 INCOMPLETE: check the saved report. Historical no-run hours remain a separate workflow gap.');process.exitCode=2;}
 else {console.log('PASS: 24-hour energy data, every authorized V2 settlement, and 12 current TEUSD balances independently verified.');if(!report.summary.full24hMatchingCoverageVerified)console.warn('ATTENTION: Full 24-hour matching/autonomy NOT verified. Review the no-B12-run hours; do not invent matches or payments.');}
}
main().catch(e=>{const x=String(e?.message??e);console.error(/postgres(?:ql)?:\/\/|private.?key|password|secret/i.test(x)?'B34 STOP: sensitive error redacted':`B34 STOP: ${x}`);process.exitCode=1;});
