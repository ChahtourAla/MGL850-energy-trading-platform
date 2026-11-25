/**
 * B30 current-hour demo finisher. READ-ONLY by default.
 * Settles only the three historically approved B28.1 matches after independent
 * on-chain verification. It does NOT create new matches, fund wallets, confirm
 * energy delivery, or substitute for an escrow/oracle implementation.
 */
import { spawnSync } from 'node:child_process';
import { open, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ALLOCATIONS, MARKET_ID, PLAN_ID, DEPLOYED_CONTRACT, parseJsonOutput, validateAll, validateSummary } from './b30-batch-core.mjs';

const mode = process.argv[2] ?? '--audit';
if(!['--audit','--settle'].includes(mode) || (mode==='--settle' && (process.argv.length!==4 || process.argv[3]!=='--confirm=SETTLE_B30_APPROVED')) || (mode==='--audit' && process.argv.length>3)) throw Error('Usage: b30-finish-demo.mjs --audit OR --settle --confirm=SETTLE_B30_APPROVED');
const root=process.cwd();
const cli='apps/backend/scripts/b28-hedera.mjs';
const nodeArgs=['--env-file=.env','--env-file=apps/backend/.env',cli];
const sensitive=/(postgres(?:ql)?:\/\/|private.?key|password|secret)/i;
function command(flags,{json=false}={}){
  const p=spawnSync(process.execPath,[...nodeArgs,...flags],{cwd:root,encoding:'utf8',env:process.env,maxBuffer:5*1024*1024,timeout:180000});
  if(p.error || p.status!==0){
    const msg=String(p.stderr||p.error?.message||p.stdout||'B28 runner failed').slice(0,700);
    throw Error(`B28 ${flags.join(' ')} failed (exit ${p.status}): ${sensitive.test(msg)?'details suppressed to protect credentials':msg}\nSTOP: do not resubmit any signed transaction. Reconcile recorded hashes.`);
  }
  if(!json){process.stdout.write(p.stdout);return p.stdout;}
  return parseJsonOutput(p.stdout);
}
function summary(){return validateSummary(command(['--mode=summary'],{json:true}));}
function preflight(a){return command(['--mode=preflight',`--allocation=${a.id}`],{json:true});}
function audit(){
  const s=summary();
  const status=validateAll(s,ALLOCATIONS.map(preflight));
  console.log(JSON.stringify({mode:'B30_DEMO_READ_ONLY',scope:'one-authorized-market-hour',marketId:MARKET_ID,planId:PLAN_ID,contract:DEPLOYED_CONTRACT,registeredHouseholdsExpected:12,matchedHouseholds:5,allocations:status.map(a=>({allocationId:a.id,amountBaseUnits:a.amount,quantityWh:a.quantityWh,state:a.state})),paymentTotalBaseUnits:'458177',noBlockchainWrites:true},null,2));
  return status;
}
async function lock(){
  const dir=join(process.env.LOCALAPPDATA??join(homedir(),'.local','share'),'mgl850-b30');
  await mkdir(dir,{recursive:true});
  // A crash leaves the lock in place intentionally: investigate first.
  const filename=join(dir,'current-hour-demo-settlement.lock');
  let file;
  try{file=await open(filename,'wx',0o600);}catch(e){if(e.code==='EEXIST')throw Error(`A prior B30 settlement lock exists at ${filename}. STOP: review on-chain journal and reconcile before removing any lock.`);throw e;}
  await file.writeFile(JSON.stringify({pid:process.pid,marketId:MARKET_ID,createdAt:new Date().toISOString()}));
  return {file,filename};
}
function validateLiveEnvironment(){
  if(process.env.B28_ENABLE_TESTNET_BROADCAST!=='I_ACCEPT_TESTNET_TRANSACTION_COSTS' || process.env.B28_ALLOW_SIMULATED_CUSTODIAL_SIGNING!=='YES' || !process.env.B28_TESTNET_OPERATOR_PRIVATE_KEY) throw Error('Explicit Testnet/custodial approvals and operator signing key are required. No broadcast.');
  if(!process.env.WALLET_ENCRYPTION_KEY_B64)throw Error('Existing household wallet encryption key missing. No broadcast.');
}
async function main(){
  if(mode==='--audit'){audit();return;}
  validateLiveEnvironment();
  const {file,filename}=await lock();
  let failed=false;
  try{
    // Independent deployed code/receipt verification; never invoke deploy.
    command(['--mode=reconcile-deployment']);
    // Reconcile recorded states *before* any new signatures. Reconciliation
    // can update journals but cannot send blockchain transactions.
    let s=summary();
    for(const a of ALLOCATIONS){
      const row=s.allocations.find(x=>x.allocationId===a.id);
      if(row.intentStatus!==null || row.attempts>0 || row.verifiedEvidence>0){
        command(['--mode=reconcile',`--allocation=${a.id}`]);
      }
    }
    const initial=audit();
    console.log(`B30 LIVE: ${initial.filter(a=>a.state==='CONFIRMED').length} already confirmed; at most ${initial.filter(a=>a.state!=='CONFIRMED').length} remaining. Contract will NOT be redeployed.`);
    for(const a of ALLOCATIONS){
      // Re-check the complete approved plan and this allocation immediately
      // before signing; never pay any unapproved household.
      s=summary();
      const row=s.allocations.find(x=>x.allocationId===a.id);
      const state=validateAll(s,ALLOCATIONS.map(preflight)).find(x=>x.id===a.id).state;
      if(state==='CONFIRMED'){
        console.log(`PASS: Previously verified, skipped ${a.id}`);
        continue;
      }
      const verb=state==='RESUME_AFTER_APPROVAL'?'resume':'execute';
      console.log(`B30: ${verb} ${a.id}, exact amount ${a.amount} TEUSD base units`);
      command([`--mode=${verb}`,`--allocation=${a.id}`,`--amount=${a.amount}`,`--plan=${PLAN_ID}`,'--confirm=I_AUTHORIZE_ONE_HEDERA_TESTNET_TRADE','--allow-custody=YES']);
      // Never submit the next payment until this one is independently reconciled.
      command(['--mode=reconcile',`--allocation=${a.id}`]);
      s=summary();
      const now=validateAll(s,ALLOCATIONS.map(preflight)).find(x=>x.id===a.id);
      if(now.state!=='CONFIRMED')throw Error(`Reconciliation did not confirm allocation ${a.id}. STOP, no further payments.`);
      console.log(`PASS: On-chain and database confirmed ${a.id}`);
    }
    const final=audit();
    if(final.some(a=>a.state!=='CONFIRMED'))throw Error('B30 final audit incomplete');
    console.log('PASS: All three authorized B28 payments confirmed and independently reconciled.');
  }catch(e){failed=true;throw e;}finally{
    await file.close().catch(()=>{});
    if(!failed){ const {unlink}=await import('node:fs/promises'); await unlink(filename).catch(()=>{}); }
    else console.error(`B30 STOP: Lock preserved at ${filename}. Do not blindly retry. Inspect journals and receipts.`);
  }
}
main().catch(e=>{const msg=String(e?.message??e);console.error(sensitive.test(msg)?'STOP: error details suppressed to protect secrets':msg);process.exitCode=1;});
