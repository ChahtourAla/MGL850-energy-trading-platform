/** B33 multi-hour Testnet payment worker, pinned to reviewed V2 markets.
 * Default read-only. Never deploys, never signs old 14:00 trades, never
 * retries unknown tx. Requires explicit approvals and existing B28 deployment.
 *
 * --mode=audit|reconcile|settle --approved=... [--confirm=SETTLE_B33_7_MARKETS]
 */
import {readFile,open,mkdir,unlink} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {homedir} from 'node:os';
import {keccak256,Contract} from '../../../packages/contracts/node_modules/ethers/lib.esm/index.js';
import {TOKEN,CHAIN_ID} from './b28-hedera-core.mjs';
import {SETTLEMENT_ABI,TOKEN_ABI,buyerNonce,domain,TYPES,authorizationDigest,recoverBuyer,rpc,operatorWallet,contractPreflight,simulatedBuyerWallet,signRawTransaction,verifyApproval} from './b28-hedera-runtime.mjs';
import {connect,restrictedWrite,addAttempt,updateAttempt,recordReceipt} from './b28-hedera-db.mjs';
import {readApprovedMarket,initialJournal} from './b33-settlement-db.mjs';
import {verifyMarketSettlement,marketTerms,marketPlanCommitment} from './b33-chain-core.mjs';
import {buildReview,assertApprovedFile,classifyAllocation,PAID_HOUR} from './b33-review-core.mjs';
const deployment=join(process.env.LOCALAPPDATA??join(homedir(),'.local','share'),'mgl850-b28-hedera','deployment.json');
const hex64=/^0x[0-9a-f]{64}$/;
function args(argv){const o={};for(const a of argv){const m=/^--(mode|approved|confirm)=(.+)$/.exec(a);if(!m||Object.hasOwn(o,m[1]))throw Error('Unknown/duplicated B33 argument');o[m[1]]=m[2];}
 if(!['audit','reconcile','settle'].includes(o.mode)||!o.approved)throw Error('Usage --mode=audit|reconcile|settle --approved=FILE');
 if(o.mode==='settle'&&o.confirm!=='SETTLE_B33_7_MARKETS')throw Error('Settlement requires explicit B33 acknowledgement');
 if(o.mode!=='settle'&&o.confirm)throw Error('Unexpected authorization flag');return o;}
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
async function readReview(file){const r=JSON.parse(await readFile(resolve(file),'utf8'));
 assertApprovedFile(r,buildReview(r.day,r.hours));
 if(r.day!=='2026-11-10'||r.hours.some(h=>h.slot===PAID_HOUR))throw Error('B33 only supports reviewed seven extra hours on 2026-11-10');
 return r;}
async function verifiedDeployment(provider){
 const d=JSON.parse(await readFile(deployment,'utf8'));
 if(d.state!=='CONFIRMED'||d.chainId!==296||!same(d.token,TOKEN)||!hex64.test(d.deployHash)||!/^0x[0-9a-f]{40}$/i.test(d.contract??''))throw Error('Trusted B28 deployment journal required; never redeploy');
 const receipt=await provider.getTransactionReceipt(d.deployHash);if(!receipt||receipt.status!==1||!same(receipt.contractAddress,d.contract)||!same(receipt.blockHash,d.blockHash))throw Error('Deployment receipt mismatch');
 const block=await provider.getBlock(receipt.blockNumber);if(!block||!same(block.hash,receipt.blockHash))throw Error('Deployment not canonical');
 const checked=await contractPreflight(provider,d.contract,d.operator);if(!same(checked.codeHash,d.codeHash))throw Error('Deployed contract code differs from B28 proof');
 if(process.env.B28_TESTNET_OPERATOR_PRIVATE_KEY&&!same(operatorWallet(provider).address,d.operator))throw Error('Unapproved Hedera settlement operator');
 return {journal:d,...checked};
}
async function view(db,hour,id,keys=false){return readApprovedMarket(db,hour,{allocationId:id,readKey:keys});}
async function status(db,provider,d,hour,alloc){
 const v=await view(db,hour,alloc.id);
 const onchain=await d.settlement.paidAllocations(alloc.id);
 const state=classifyAllocation(v.intent,v.attempts,v.evidence,onchain);
 if(state==='CONFIRMED'){
  const tx=v.attempts.find(a=>a.transactionIdentity==='B28_SETTLEMENT');
  if(!tx||v.evidence[0]?.txHash!==tx.txHash||v.intent.contractAddress?.toLowerCase()!==d.journal.contract.toLowerCase())throw Error('Confirmed journal missing canonical settlement attempt');
  await verifyMarketSettlement(provider,{hash:tx.txHash,contract:d.journal.contract,hour,allocation:v.allocation,expectedDigest:v.intent.id,operator:d.journal.operator});
 }
 else{
  const used=await d.settlement.usedNonces(alloc.buyerAddress,buyerNonce(alloc.id));
  if(used)throw Error('Buyer nonce used on-chain despite no confirmed evidence');
  const onPlan=await d.settlement.marketPlans(hour.marketId);
  if(onPlan!=='0x'+'0'.repeat(64)&&(!same(onPlan,marketPlanCommitment(hour))||!same(await d.settlement.marketSnapshots(hour.marketId),hour.snapshotHash)))throw Error('Conflicting market commitment on-chain');
  if(state==='RESUME_AFTER_APPROVAL'){
   const ap=v.attempts[0];await verifyApproval(provider,ap.txHash,alloc.buyerAddress,d.journal.contract,alloc.amountBaseUnits);
   if(!ap.recoveryMetadata?.deadline||BigInt(ap.recoveryMetadata.deadline)<=BigInt(Math.floor(Date.now()/1000)+90))throw Error('Previous approval has expired authorization; manual recovery required');
  }
  if(await d.token.balanceOf(alloc.buyerAddress)<BigInt(alloc.amountBaseUnits)||await provider.getBalance(alloc.buyerAddress)<=0n)throw Error('Buyer has insufficient TEUSD/HBAR');
 }
 return {view:v,state,txHash:v.evidence[0]?.txHash??null};
}
async function audit(db,provider,d,review){const all=[];
 for(const h of review.hours){for(const a of h.allocations){const x=await status(db,provider,d,h,a);all.push({hour:h.slot,allocationId:a.id,buyer:a.buyerAddress,seller:a.sellerAddress,amountBaseUnits:a.amountBaseUnits,state:x.state,transactionHash:x.txHash});}}
 console.table(all.map(x=>({hour:x.hour.slice(11,16),allocation:x.allocationId.slice(0,12),baseUnits:x.amountBaseUnits,status:x.state,tx:x.transactionHash??''})));
 console.log('SUMMARY',JSON.stringify({mode:'B33_SEVEN_MARKETS_READ_ONLY',markets:review.hours.length,allocations:all.length,confirmed:all.filter(x=>x.state==='CONFIRMED').length,eligible:all.filter(x=>x.state==='ELIGIBLE').length,resume:all.filter(x=>x.state==='RESUME_AFTER_APPROVAL').length,baseUnits:all.reduce((a,b)=>a+BigInt(b.amountBaseUnits),0n).toString(),noBlockchainWrites:true}));return all;
}
async function recordAndBroadcast(db,provider,{settlementId,attempt,raw,hash,stage}){
 // Only broadcast after the exact signed hash is durable in PostgreSQL.
 const sent=await provider.broadcastTransaction(raw);if(!same(sent.hash,hash))throw Error('Provider returned a different transaction hash');
 await updateAttempt(db,{id:attempt.id,status:'SUBMITTED',intentStatus:stage==='settlement'?'SUBMITTED':undefined});
 const r=await provider.waitForTransaction(hash,1,120000);
 if(!r||r.status!==1)throw Error('Unknown/reverted transaction outcome; use B33 reconcile, NEVER resubmit');return r;
}
async function completeSettlement(db,provider,d,h,a,v,buyer,operator,terms,signature,digest,approvalJournaled){
 const contract=d.journal.contract,nonce=buyerNonce(a.id);
 if(await d.settlement.paidAllocations(a.id)||await d.settlement.usedNonces(a.buyerAddress,nonce))throw Error('Already paid on-chain; reconcile and stop');
 if(await d.token.allowance(a.buyerAddress,contract)<BigInt(a.amountBaseUnits))throw Error('Insufficient token approval');
 await d.settlement.connect(operator).settle.staticCall(terms,signature);
 const tx=await signRawTransaction(operator,{to:contract,data:d.settlement.interface.encodeFunctionData('settle',[terms,signature])});
 const attempt=approvalJournaled
  ?await addAttempt(db,{settlementId:digest,txHash:tx.hash,nonce:tx.nonce,metadata:{kind:'settlement',deadline:terms.deadline.toString(),buyerNonce:terms.nonce.toString()}})
  :await initialJournal(db,{settlementId:digest,a:v.allocation,contract,token:TOKEN,hash:tx.hash,nonce:tx.nonce,kind:'B28_SETTLEMENT',metadata:{deadline:terms.deadline.toString(),buyerNonce:terms.nonce.toString()}});
 console.log('B33 signed settlement HASH journaled:',tx.hash);
 await recordAndBroadcast(db,provider,{settlementId:digest,attempt,raw:tx.raw,hash:tx.hash,stage:'settlement'});
 const proof=await verifyMarketSettlement(provider,{hash:tx.hash,contract,hour:h,allocation:v.allocation,expectedDigest:digest,operator:operator.address});
 await recordReceipt(db,{settlementId:digest,attemptId:attempt.id,txHash:tx.hash,blockHash:proof.blockHash,logIndex:proof.settlementLogIndex,allocation:v.allocation,contract,token:TOKEN});
 console.log('PASS: B33 onchain and database payment confirmed:',a.id,tx.hash);
}
async function settleOne(db,provider,d,h,allocation,prior){
 const a=allocation,contract=d.journal.contract;
 const v=await view(db,h,a.id,true),operator=operatorWallet(provider),buyer=await simulatedBuyerWallet(v.buyerWallet,provider);
 if(!same(buyer.address,a.buyerAddress)||!same(operator.address,d.journal.operator))throw Error('Private signing wallet identity mismatch');
 let deadline,previouslyApproved=prior.state==='RESUME_AFTER_APPROVAL';
 if(previouslyApproved){
  if(v.intent?.status!=='READY'||v.attempts.length!==1||v.attempts[0].status!=='CONFIRMED'||v.attempts[0].transactionIdentity!=='B28_APPROVAL')throw Error('Unrecognized approval journal');
  deadline=BigInt(v.attempts[0].recoveryMetadata?.deadline);
  await verifyApproval(provider,v.attempts[0].txHash,buyer.address,contract,a.amountBaseUnits);
 }else{
  if(v.intent||v.attempts.length||v.evidence.length)throw Error('Prior journal activity: stop');
  deadline=BigInt(Math.floor(Date.now()/1000)+3600);
 }
 const terms=marketTerms(h,v.allocation,buyerNonce(a.id),deadline);
 const digest=authorizationDigest(terms,contract),signature=await buyer.signTypedData(domain(contract),TYPES,terms);
 if(!recoverBuyer(terms,contract,signature)||!same(await d.settlement.settlementId(terms),digest))throw Error('EIP712 buyer signature mismatch');
 if(previouslyApproved){await completeSettlement(db,provider,d,h,a,v,buyer,operator,terms,signature,digest,true);return;}
 const allowance=await d.token.allowance(a.buyerAddress,contract);
 if(allowance<BigInt(a.amountBaseUnits)){
  const tx=await signRawTransaction(buyer,{to:TOKEN,data:d.token.interface.encodeFunctionData('approve',[contract,BigInt(a.amountBaseUnits)])});
  const ap=await initialJournal(db,{settlementId:digest,a:v.allocation,contract,token:TOKEN,hash:tx.hash,nonce:tx.nonce,kind:'B28_APPROVAL',metadata:{deadline:terms.deadline.toString(),buyerNonce:terms.nonce.toString(),approvalAmount:String(a.amountBaseUnits)}});
  console.log('B33 signed buyer APPROVAL journaled:',tx.hash);
  await recordAndBroadcast(db,provider,{settlementId:digest,attempt:ap,raw:tx.raw,hash:tx.hash,stage:'approval'});
  await verifyApproval(provider,tx.hash,buyer.address,contract,a.amountBaseUnits);
  await updateAttempt(db,{id:ap.id,status:'CONFIRMED',intentStatus:'READY'});
  console.log('PASS: B33 buyer approval confirmed:',tx.hash);
  await completeSettlement(db,provider,d,h,a,v,buyer,operator,terms,signature,digest,true);return;
 }
 await completeSettlement(db,provider,d,h,a,v,buyer,operator,terms,signature,digest,false);
}
async function reconcileKnown(db,provider,d,review){
 for(const h of review.hours){for(const a of h.allocations){
  const v=await view(db,h,a.id);
  if(!v.intent)continue;
  if(!same(v.intent.contractAddress,d.journal.contract))throw Error('Recorded settlement has different contract');
  const ap=v.attempts.find(x=>x.transactionIdentity==='B28_APPROVAL');
  const tx=v.attempts.find(x=>x.transactionIdentity==='B28_SETTLEMENT');
  if(ap&&ap.status!=='CONFIRMED'){
   const receipt=await provider.getTransactionReceipt(ap.txHash);
   if(!receipt)throw Error(`APPROVAL OUTCOME UNKNOWN: ${ap.txHash}. Do not retry.`);
   if(receipt.status!==1)throw Error(`Approval reverted: ${ap.txHash}. Manual recovery required.`);
   await verifyApproval(provider,ap.txHash,a.buyerAddress,d.journal.contract,a.amountBaseUnits);
   await updateAttempt(db,{id:ap.id,status:'CONFIRMED',intentStatus:'READY'});
  }
  if(tx){
   const receipt=await provider.getTransactionReceipt(tx.txHash);
   if(!receipt)throw Error(`SETTLEMENT OUTCOME UNKNOWN: ${tx.txHash}. Do not resubmit.`);
   if(receipt.status!==1)throw Error(`Settlement reverted: ${tx.txHash}. Manual recovery required.`);
   const proof=await verifyMarketSettlement(provider,{hash:tx.txHash,contract:d.journal.contract,hour:h,allocation:v.allocation,expectedDigest:v.intent.id,operator:d.journal.operator});
   if(v.intent.status==='CONFIRMED'){if(v.evidence.length!==1||v.evidence[0].txHash!==tx.txHash)throw Error('Conflicting confirmed evidence');}
   else{if(v.evidence.length)throw Error('Conflicting prior proof');await recordReceipt(db,{settlementId:v.intent.id,attemptId:tx.id,txHash:tx.txHash,blockHash:proof.blockHash,logIndex:proof.settlementLogIndex,allocation:v.allocation,contract:d.journal.contract,token:TOKEN});}
  }
 }}
}
async function lock(){const file=join(process.env.LOCALAPPDATA??join(homedir(),'.local','share'),'mgl850-b33','full-day-payment.lock');await mkdir(dirname(file),{recursive:true});const f=await open(file,'wx',0o600);await f.writeFile(JSON.stringify({pid:process.pid,day:'2026-11-10',createdAt:new Date().toISOString()}));return {f,file};}
async function main(){const x=args(process.argv.slice(2)),review=await readReview(x.approved);
 const db=await connect();let guard=null,done=false;
 try{const provider=await rpc(),d=await verifiedDeployment(provider);
  if(x.mode==='audit'){await audit(db,provider,d,review);return;}
  if(x.mode==='reconcile'){await reconcileKnown(db,provider,d,review);await audit(db,provider,d,review);console.log('PASS: Known journal transactions independently reconciled; no broadcasts');return;}
  if(process.env.B28_ENABLE_TESTNET_BROADCAST!=='I_ACCEPT_TESTNET_TRANSACTION_COSTS'||process.env.B28_ALLOW_SIMULATED_CUSTODIAL_SIGNING!=='YES'||!process.env.B28_TESTNET_OPERATOR_PRIVATE_KEY||!process.env.WALLET_ENCRYPTION_KEY_B64)throw Error('Explicit testnet/custodial authorization, operator key, wallet encryption key required');
  const operator=operatorWallet(provider);if(!same(operator.address,d.journal.operator)||await provider.getBalance(operator.address)<=0n)throw Error('Unfunded/wrong operator');
  guard=await lock();
  // DO NOT reconcile implicitly during live sends: unknown receipts require independent review.
  const first=await audit(db,provider,d,review);
  console.log(`B33: ${first.filter(x=>x.state==='CONFIRMED').length} already confirmed, ${first.filter(x=>x.state!=='CONFIRMED').length} remaining. No redeploy; old 14:00 is excluded.`);
  for(const h of review.hours){for(const a of h.allocations){
   const current=await status(db,provider,d,h,a);
   if(current.state==='CONFIRMED'){console.log('SKIP: Already independently confirmed',a.id);continue;}
   console.log('B33 settle:',h.slot,a.id,a.amountBaseUnits);
   await settleOne(db,provider,d,h,a,current);
   const checked=await status(db,provider,d,h,a);if(checked.state!=='CONFIRMED')throw Error('Settlement did not independently confirm; stop before next payment');
  }}
  const final=await audit(db,provider,d,review);if(final.some(x=>x.state!=='CONFIRMED'))throw Error('Missing final verified payment');
  done=true;console.log('PASS: All seven additionally approved V2 market hours settled and reconciled. Existing 14:00 trades untouched.');
 }finally{await db.end().catch(()=>{});if(guard){await guard.f.close().catch(()=>{});if(done)await unlink(guard.file).catch(()=>{});else console.error('B33 HALT: lock preserved for recovery. Never rerun blindly:',guard.file);}}
}
main().catch(e=>{const s=String(e?.message??e);console.error(/private.?key|postgres(?:ql)?:\/\/|password|secret/i.test(s)?'B33 STOP: sensitive error redacted':`B33 STOP: ${s}`);console.error('If ANY signed hash exists, run --mode=reconcile and inspect the journal before any further settlement.');process.exitCode=1;});
