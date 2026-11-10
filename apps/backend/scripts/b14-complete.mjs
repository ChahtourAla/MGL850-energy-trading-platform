/** One controlled B14 completion command. No background work and no blind retries. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const path=fileURLToPath(new URL('./b14-finish.mjs',import.meta.url));
const flags={};
for(let i=2;i<process.argv.length;i++){
  const k=process.argv[i];
  if(!['--match-id','--delivery-start','--execute','--verify'].includes(k)||Object.hasOwn(flags,k))throw new Error(`Bad/duplicate argument ${k}`);
  if(k==='--execute'||k==='--verify'){flags[k]=true;continue;}
  if(!process.argv[i+1]||process.argv[i+1].startsWith('--'))throw new Error(`Missing value ${k}`);
  flags[k]=process.argv[++i];
}
if(flags['--verify']&&flags['--execute'])throw new Error('Use either --verify or --execute, not both');
if(!flags['--match-id']||!flags['--delivery-start'])throw new Error('Required: --match-id UUID --delivery-start UTC [--execute]');
if(flags['--execute'] && process.env.B14_FINISH_ALL_CONFIRM!=='EXECUTE_EXACT_APPROVAL_CREATE_AND_FUND_ON_HEDERA_TESTNET'){
  throw new Error('Explicit consent required: set B14_FINISH_ALL_CONFIRM=EXECUTE_EXACT_APPROVAL_CREATE_AND_FUND_ON_HEDERA_TESTNET');
}
const confirm={STAGE:'B14_STAGE_EXACT_OPERATION',SEAL:'B14_SIGN_EXACT_OPERATION_NO_SEND',SUBMIT:'B14_SEND_EXACT_STORED_TESTNET_TX',RECONCILE:'B14_RECONCILE_ONLY'};
function cli(step,action){
  const command=[path,'--match-id',flags['--match-id'],'--step',step,'--action',action];
  if(step==='CREATE_TRADE')command.push('--delivery-start',flags['--delivery-start']);
  const env={...process.env};
  if(confirm[action])env.B14_FINAL_CONFIRM=confirm[action];
  else delete env.B14_FINAL_CONFIRM;
  const result=spawnSync(process.execPath,command,{stdio:['ignore','pipe','pipe'],encoding:'utf8',env,timeout:90000,maxBuffer:1024*1024});
  if(result.stdout)process.stdout.write(result.stdout);
  if(result.stderr)process.stderr.write(result.stderr);
  if(result.error||result.status!==0)throw new Error(`B14 ${step} ${action} stopped. Do not retry SUBMIT; inspect exact journal. ${result.error?.message||'exit '+result.status}`);
  return result.stdout;
}
function checkFrom(text){
  const start=text.indexOf('B14 FINAL CHECK: ');
  if(start<0)throw new Error('Missing B14 FINAL CHECK line');
  const chunk=text.slice(start+'B14 FINAL CHECK: '.length);let depth=0,inString=false,escaped=false;
  for(let i=0;i<chunk.length;i++){const ch=chunk[i];if(inString){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')inString=false;continue;}
    if(ch==='"'){inString=true;continue;}if(ch==='{')depth++;if(ch==='}'&&--depth===0)return JSON.parse(chunk.slice(0,i+1));}
  throw new Error('Cannot parse B14 output');
}
function statusFrom(text){
  const line=text.split(/\r?\n/).find(s=>s.startsWith('B14 FINAL CHECK: '));
  if(!line)return 'UNKNOWN';
  // The check is pretty-printed; parse between marker and following log lines.
  const start=text.indexOf('B14 FINAL CHECK: ')+ 'B14 FINAL CHECK: '.length;
  const chunk=text.slice(start); let depth=0,inString=false,escaped=false;
  for(let i=0;i<chunk.length;i++){
    const ch=chunk[i];if(inString){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')inString=false;continue;}
    if(ch==='"'){inString=true;continue;}
    if(ch==='{')depth++;
    if(ch==='}') {depth--;if(depth===0)return JSON.parse(chunk.slice(0,i+1)).journalStatus;}
  }
  throw new Error('Could not parse journal status from output');
}
const steps=['APPROVE_ESCROW','CREATE_TRADE','FUND_TRADE'];
if(flags['--verify']){
  console.log('B14 UNIFIED VERIFY: read-only; checking all B14 journal states and live escrow');
  for(const step of steps){
    const check=checkFrom(cli(step,'STATUS'));
    if(check.journalStatus!=='CONFIRMED')throw new Error(`${step} not confirmed: ${check.journalStatus}`);
    if(step==='FUND_TRADE'){
      if(check.chainTradeStatus!=='AWAITING_DELIVERY'||BigInt(check.chainTradeId)<=0n||BigInt(check.buyerBalanceUnits)!==0n||BigInt(check.escrowTokenUnits)<BigInt(check.paymentUnits))
        throw new Error('Funded trade or escrow token balance inconsistent');
      console.log(`B14 VERIFIED ON CHAIN: tradeId=${check.chainTradeId} status=${check.chainTradeStatus} escrowUnits=${check.escrowTokenUnits}`);
    }
  }
  console.log('B14 UNIFIED VERIFY PASS: three confirmed operations, linked trade and funded escrow; earlier HBAR/mint receipts checked');
}else if(!flags['--execute']){
  console.log('B14 UNIFIED PREVIEW: read-only, no signatures or database changes');
  cli('APPROVE_ESCROW','PREVIEW');
  console.log('B14 UNIFIED PREVIEW PASS: to run all three operations later, use --execute with exact confirmation');
}else{
  console.log('B14 UNIFIED EXECUTE: three separate journaled testnet transactions; stops on uncertainty or any failed check');
  for(const step of steps){
    console.log(`\n====== B14 ${step} ======`);
    let status=statusFrom(cli(step,'STATUS'));
    if(status==='NOT_STAGED'){cli(step,'STAGE');status='PLANNED';}
    if(status==='PLANNED'){cli(step,'SEAL');status='SIGNED';}
    if(status==='SIGNED'){cli(step,'SUBMIT');status='SUBMITTED';}
    if(['SUBMITTED','NEEDS_RECONCILIATION'].includes(status)){
      // Reconcile existing hash only. Never re-send a transaction on uncertainty.
      for(let attempt=0;attempt<5;attempt++){
        if(attempt>0)await new Promise(resolve=>setTimeout(resolve,4500));
        cli(step,'RECONCILE');
        status=statusFrom(cli(step,'STATUS'));
        if(status==='CONFIRMED'||status==='REVERTED')break;
      }
    }
    if(status!=='CONFIRMED')throw new Error(`${step} is ${status}; STOP. Use reconciliation for the same hash, never SUBMIT again.`);
    console.log(`B14 ${step}: CONFIRMED`);
  }
  console.log('B14 UNIFIED FINISH PASS: approval, trade creation and escrow funding all CONFIRMED. Check on-chain status AWAITING_DELIVERY.');
}
