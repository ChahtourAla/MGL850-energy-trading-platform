/**
 * B28 integrated Hedera Testnet demonstration: setup / deploy / preflight /
 * execute / reconcile / resume. NO mode broadcasts by default.
 * The B24/B25 disposable-only code is never imported or modified.
 */
import {readFile,writeFile,mkdir,open} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {homedir} from 'node:os';
import {getAddress,keccak256,Contract,ContractFactory} from '../../../packages/contracts/node_modules/ethers/lib.esm/index.js';
import {ADMIN,CHAIN_ID,CHOSEN,MARKET,PLAN,TOKEN,assertExecutionApproval,assertDeploymentInputs,assertNoPrior} from './b28-hedera-core.mjs';
import {connect,getMarket,setupRole,makeIntentAndAttempt,addAttempt,updateAttempt,recordReceipt} from './b28-hedera-db.mjs';
import {SETTLEMENT_ABI,TOKEN_ABI,algorithmId,authorizationDigest,buyerNonce,compiledArtifact,contractPreflight,deployerWallet,domain,operatorWallet,planCommitment,policyId,recoverBuyer,rpc,settlementTerms,signRawTransaction,simulatedBuyerWallet,TYPES,verifyApproval,verifySettlement} from './b28-hedera-runtime.mjs';
const PATH=join(process.env.LOCALAPPDATA??join(homedir(),'.local','share'),'mgl850-b28-hedera','deployment.json');
const TOK=/^0x[0-9a-fA-F]{64}$/;
function args(argv){
 const o={};for(const arg of argv){const m=/^--([a-z-]+)=(.+)$/.exec(arg);if(!m||Object.hasOwn(o,m[1]))throw Error('Invalid or duplicate command-line option');o[m[1]]=m[2];}
 if(!['setup','deploy','reconcile-deployment','preflight','execute','reconcile','resume'].includes(o.mode))throw Error('Choose --mode=setup|deploy|reconcile-deployment|preflight|execute|reconcile|resume');
 if(Object.keys(o).some(k=>!['mode','allocation','amount','plan','confirm','allow-custody'].includes(k)))throw Error('Unknown B28 option');
 return o;
}
function safeMessage(e){const s=String(e?.message??e);return /private.key|password|postgres(?:ql)?:\/\//i.test(s)?'Error details suppressed to prevent credential disclosure':s;}
async function state(){try{return JSON.parse(await readFile(PATH,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function saveState(s,{first=false}={}){
 await mkdir(dirname(PATH),{recursive:true});
 if(first){const f=await open(PATH,'wx',0o600);try{await f.writeFile(JSON.stringify(s,null,2));}finally{await f.close();}}
 else await writeFile(PATH,JSON.stringify(s,null,2),{mode:0o600});
}
function mustHaveLiveEnv(){if(process.env.B28_ENABLE_TESTNET_BROADCAST!=='I_ACCEPT_TESTNET_TRANSACTION_COSTS')throw Error('B28_ENABLE_TESTNET_BROADCAST acknowledgement missing');}
async function pinnedView(c,{readKey=false}={}){
 await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{const x=await getMarket(c,{readKey});await c.query('COMMIT');return x;}
 catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}
}
async function deployed(provider,operator){
 const saved=await state();
 if(!saved||saved.state!=='CONFIRMED'||saved.chainId!==CHAIN_ID||saved.token?.toLowerCase()!==TOKEN.toLowerCase()||saved.operator?.toLowerCase()!==operator.toLowerCase())throw Error('B28 versioned deployment not confirmed in local deployment journal; run deploy or reconcile deployment');
 const receipt=await provider.getTransactionReceipt(saved.deployHash);
 if(!receipt||receipt.status!==1||receipt.contractAddress?.toLowerCase()!==saved.contract.toLowerCase())throw Error('Deployment receipt is missing or changed');
 const block=await provider.getBlock(receipt.blockNumber);
 if(!block||block.hash!==receipt.blockHash)throw Error('Deployment no longer canonical');
 const checked=await contractPreflight(provider,saved.contract,operator);
 if(checked.codeHash!==saved.codeHash)throw Error('Deployed contract runtime code changed');
 return {saved,...checked};
}
async function deploy(provider){
 mustHaveLiveEnv();
 const deployer=deployerWallet(provider),operator=operatorWallet(provider),pauser=process.env.B28_TESTNET_PAUSER_ADDRESS;
 assertDeploymentInputs(deployer.address,operator.address,pauser);
 if((await provider.getBalance(deployer.address))<=0n||(await provider.getBalance(operator.address))<=0n)throw Error('Deployer and separate operator must both have Testnet HBAR before deployment');
 if(await state())throw Error('Deployment journal exists; DO NOT REDEPLOY. Inspect/reconcile the existing hash');
 const artifact=await compiledArtifact();
 const factory=new ContractFactory(artifact.abi,artifact.bytecode,deployer);
 const req=await factory.getDeployTransaction(TOKEN,deployer.address,operator.address,getAddress(pauser));
 const populated=await deployer.populateTransaction({...req,chainId:CHAIN_ID});
 if(populated.to)throw Error('Deployment unexpectedly targets an existing contract');
 const raw=await deployer.signTransaction(populated),hash=keccak256(raw).toLowerCase();
 await saveState({state:'SIGNED_NOT_YET_CONFIRMED',deployHash:hash,chainId:CHAIN_ID,token:TOKEN,operator:operator.address,deployer:deployer.address,pauser:getAddress(pauser),artifactHash:keccak256(artifact.bytecode)},{first:true});
 console.log('B28 deployment hash journaled before broadcast:',hash);
 const sent=await provider.broadcastTransaction(raw);
 if(sent.hash.toLowerCase()!==hash)throw Error('Unexpected deployment hash');
 const receipt=await provider.waitForTransaction(hash,1,120000);
 if(!receipt||receipt.status!==1||!receipt.contractAddress)throw Error('Deployment outcome unavailable or failed; reconcile before another transaction');
 const checked=await contractPreflight(provider,receipt.contractAddress,operator.address);
 const saved={...(await state()),state:'CONFIRMED',contract:getAddress(receipt.contractAddress),codeHash:checked.codeHash,blockHash:receipt.blockHash,blockNumber:receipt.blockNumber};
 await saveState(saved);
 console.log(JSON.stringify({status:'B28_HALF_EVEN_CONTRACT_DEPLOYED',contract:saved.contract,transactionHash:hash,token:TOKEN,chainId:CHAIN_ID,journal:PATH,backendConfig:`B27_EXPECTED_SETTLEMENT_ADDRESS=${saved.contract}`,nextStep:'Restart the NestJS backend after updating B27_EXPECTED_SETTLEMENT_ADDRESS.'},null,2));
}
async function reconcileDeployment(provider){
 const saved=await state();
 if(!saved||!TOK.test(saved.deployHash))throw Error('Missing signed deployment transaction journal');
 if(saved.state==='CONFIRMED'){
  const operator=operatorWallet(provider);
  const d=await deployed(provider,operator.address);
  console.log('PASS: Existing B28 deployment independently verified:',d.saved.contract);return;
 }
 const receipt=await provider.getTransactionReceipt(saved.deployHash);
 if(!receipt){console.log('DEPLOYMENT_OUTCOME_UNKNOWN: do not redeploy. Hash:',saved.deployHash);return;}
 if(receipt.status!==1||!receipt.contractAddress)throw Error('Deployment failed on-chain. Do not automatically resubmit.');
 const operator=operatorWallet(provider);
 if(saved.operator.toLowerCase()!==operator.address.toLowerCase())throw Error('Deployment operator key mismatch');
 const checked=await contractPreflight(provider,receipt.contractAddress,operator.address);
 await saveState({...saved,state:'CONFIRMED',contract:getAddress(receipt.contractAddress),codeHash:checked.codeHash,blockHash:receipt.blockHash,blockNumber:receipt.blockNumber});
 console.log('PASS: Deployment reconciled:',receipt.contractAddress);
}
async function preflight(provider,c){
 const view=await pinnedView(c);
 const operator=process.env.B28_TESTNET_OPERATOR_PRIVATE_KEY ? operatorWallet(provider).address : null;
 let contract=null,contractStatus='DEPLOYMENT_REQUIRED',allowance=null,balance=null;
 const buyerHbar=await provider.getBalance(view.allocation.buyerAddress);
 const operatorHbar=operator?await provider.getBalance(operator):null;
 if(operator){
  const deployedState=await state();
  if(deployedState?.state==='CONFIRMED'){
   const d=await deployed(provider,operator);
   contract=d.saved.contract;contractStatus='VERSIONED_CONTRACT_VERIFIED';
   [allowance,balance]=await Promise.all([d.token.allowance(view.allocation.buyerAddress,contract),d.token.balanceOf(view.allocation.buyerAddress)]);
  }
 }
 console.log(JSON.stringify({mode:'B28_TESTNET_READ_ONLY_PREFLIGHT',simulationOnly:true,chainId:CHAIN_ID,marketId:MARKET,planId:PLAN,allocationId:view.allocation.id,buyer:view.allocation.buyerAddress,seller:view.allocation.sellerAddress,quantityWh:String(view.allocation.quantityWh),paymentBaseUnits:String(view.allocation.amountBaseUnits),policy:view.allocation.pricingVersion,contract,contractStatus,allowanceBaseUnits:allowance?.toString()??null,buyerBalanceBaseUnits:balance?.toString()??null,buyerHbarWei:buyerHbar.toString(),operatorHbarWei:operatorHbar?.toString()??null,existingIntentStatus:view.intent?.status??null,previousAttempts:view.attempts.length,readyForAutomaticLiveSend:false},null,2));
}
async function addAndBroadcast(c,{intentId,attempt,raw,hash,provider,intentStatus}){
 try{
  const tx=await provider.broadcastTransaction(raw);
  if(tx.hash.toLowerCase()!==hash)throw Error('Broadcast hash differs from journaled transaction');
  await updateAttempt(c,{id:attempt.id,status:'SUBMITTED',intentStatus});
  const receipt=await provider.waitForTransaction(hash,1,120000);
  if(!receipt||receipt.status!==1)throw Error('Transaction not conclusively successful; reconcile before retry');
  return receipt;
 }catch(e){
  await updateAttempt(c,{id:attempt.id,status:'NEEDS_RECONCILIATION',intentStatus:'UNKNOWN'}).catch(()=>{});
  throw e;
 }
}
async function finishSettlement(c,provider,{operator,view,terms,signature,settlementId,contract,approvalAlreadyJournaled}){
 const d=await deployed(provider,operator.address);
 if(d.saved.contract.toLowerCase()!==contract.toLowerCase())throw Error('Settlement contract changed');
 if(!recoverBuyer(terms,contract,signature)||authorizationDigest(terms,contract)!==settlementId)throw Error('Buyer signature could not be verified');
 const [paid,used,allowance,balance]=await Promise.all([
  d.settlement.paidAllocations(view.allocation.id),d.settlement.usedNonces(view.allocation.buyerAddress,terms.nonce),
  d.token.allowance(view.allocation.buyerAddress,contract),d.token.balanceOf(view.allocation.buyerAddress),
 ]);
 if(paid||used||allowance<terms.amountBaseUnits||balance<terms.amountBaseUnits)throw Error('Stale replay state, allowance or balance');
 if((await d.settlement.marketPlans(MARKET))!=='0x'+'0'.repeat(64)){
  if((await d.settlement.marketPlans(MARKET)).toLowerCase()!==terms.planCommitment.toLowerCase()||(await d.settlement.marketSnapshots(MARKET)).toLowerCase()!==terms.snapshotHash.toLowerCase())throw Error('Market plan already bound to a different commitment');
 }
 // This read-only EVM simulation rejects invalid signatures, expired terms and token failures before signing the operator transaction.
 await d.settlement.connect(operator).settle.staticCall(terms,signature);
 const tx=await signRawTransaction(operator,{to:contract,data:d.settlement.interface.encodeFunctionData('settle',[terms,signature])});
 let attempt;
 if(approvalAlreadyJournaled)attempt=await addAttempt(c,{settlementId,txHash:tx.hash,nonce:tx.nonce,metadata:{kind:'settlement',deadline:terms.deadline.toString(),buyerNonce:terms.nonce.toString()}});
 else attempt=await makeIntentAndAttempt(c,{settlementId,allocation:view.allocation,contract,token:TOKEN,attemptHash:tx.hash,nonce:tx.nonce,kind:'B28_SETTLEMENT',metadata:{deadline:terms.deadline.toString(),buyerNonce:terms.nonce.toString()}});
 await addAndBroadcast(c,{intentId:settlementId,attempt,raw:tx.raw,hash:tx.hash,provider,intentStatus:'SUBMITTED'});
 // Independently re-open canonical transaction and event records before recording a payment.
 const evidence=await verifySettlement(provider,{hash:tx.hash,contract,allocation:view.allocation,allocations:view.allocations,expectedDigest:settlementId,operator:operator.address});
 await recordReceipt(c,{settlementId,attemptId:attempt.id,txHash:tx.hash,blockHash:evidence.blockHash,logIndex:evidence.settlementLogIndex,allocation:view.allocation,contract,token:TOKEN});
 const final=await pinnedView(c);
 if(final.intent?.status!=='CONFIRMED'||final.evidence.length!==1||final.evidence[0].verificationStatus!=='VERIFIED')throw Error('Database final proof mismatch; manual reconciliation required');
 console.log(JSON.stringify({state:'B28_HE_DEMO_SETTLEMENT_CONFIRMED',transactionHash:tx.hash,allocationId:view.allocation.id,paymentBaseUnits:String(view.allocation.amountBaseUnits),buyer:view.allocation.buyerAddress,seller:view.allocation.sellerAddress,blockNumber:evidence.blockNumber,settlementEventIndex:evidence.settlementLogIndex,tokenTransferIndex:evidence.transferLogIndex,simulationOnly:true},null,2));
}
async function execute(c,provider,flags,resume=false){
 mustHaveLiveEnv();
 const view=await pinnedView(c,{readKey:true}),a=view.allocation;
 assertExecutionApproval({mode:'execute',allocation:flags.allocation,amount:flags.amount,plan:flags.plan,confirm:flags.confirm,allowCustody:flags['allow-custody']},a);
 const operator=operatorWallet(provider),d=await deployed(provider,operator.address),contract=d.saved.contract;
 if((await provider.getBalance(operator.address))<=0n)throw Error('Hedera operator has no Testnet HBAR for settlement gas');
 const buyer=await simulatedBuyerWallet(view.buyerWallet,provider);
 const tokenBalance=await d.token.balanceOf(a.buyerAddress);
 if(tokenBalance<BigInt(a.amountBaseUnits))throw Error('Buyer balance insufficient');
 const feeHBAR=await provider.getBalance(buyer.address);
 if(feeHBAR<=0n)throw Error('Buyer has no Testnet HBAR for token approval fees');
 const nonce=buyerNonce(a.id);
 let terms,signature,settlementId;
 if(resume){
  if(!view.intent||view.intent.status!=='READY'||view.attempts.length!==1||view.attempts[0].transactionIdentity!=='B28_APPROVAL'||view.attempts[0].status!=='CONFIRMED')throw Error('Resume requires one confirmed approval and no settlement attempt');
  const meta=view.attempts[0].recoveryMetadata;
  if(!meta||!/^\d+$/.test(String(meta.deadline)))throw Error('No stored signing deadline');
  terms=settlementTerms(a,view.allocations,nonce,meta.deadline);
  settlementId=authorizationDigest(terms,contract);
  if(settlementId!==view.intent.id||terms.deadline<=BigInt(Math.floor(Date.now()/1000)+90))throw Error('Stored authorization expired or changed; do not create an alternative silently');
  await verifyApproval(provider,view.attempts[0].txHash,buyer.address,contract,a.amountBaseUnits);
 }else{
  assertNoPrior(view.intent,view.attempts);
  const [paid,used]=await Promise.all([d.settlement.paidAllocations(a.id),d.settlement.usedNonces(a.buyerAddress,nonce)]);
  if(paid||used)throw Error('Allocation or buyer nonce already used on-chain');
  const deadline=Math.floor(Date.now()/1000)+3600;
  terms=settlementTerms(a,view.allocations,nonce,deadline);
  settlementId=authorizationDigest(terms,contract);
 }
 signature=await buyer.signTypedData(domain(contract),TYPES,terms);
 if(!recoverBuyer(terms,contract,signature)||(await d.settlement.settlementId(terms)).toLowerCase()!==settlementId)throw Error('EIP-712 signing or contract digest mismatch');
 if(!resume){
  const allowance=await d.token.allowance(buyer.address,contract);
  if(allowance<BigInt(a.amountBaseUnits)){
   const tx=await signRawTransaction(buyer,{to:TOKEN,data:d.token.interface.encodeFunctionData('approve',[contract,BigInt(a.amountBaseUnits)])});
   const attempt=await makeIntentAndAttempt(c,{settlementId,allocation:a,contract,token:TOKEN,attemptHash:tx.hash,nonce:tx.nonce,kind:'B28_APPROVAL',metadata:{deadline:terms.deadline.toString(),buyerNonce:terms.nonce.toString(),approvalAmount:String(a.amountBaseUnits)}});
   console.log('Buyer token approval journaled before broadcast:',tx.hash);
   await addAndBroadcast(c,{intentId:settlementId,attempt,raw:tx.raw,hash:tx.hash,provider});
   await verifyApproval(provider,tx.hash,buyer.address,contract,a.amountBaseUnits);
   await updateAttempt(c,{id:attempt.id,status:'CONFIRMED',intentStatus:'READY'});
   console.log('Buyer exact-amount TEUSD approval confirmed:',tx.hash);
   await finishSettlement(c,provider,{operator,view,terms,signature,settlementId,contract,approvalAlreadyJournaled:true});
   return;
  }
 }
 await finishSettlement(c,provider,{operator,view,terms,signature,settlementId,contract,approvalAlreadyJournaled:resume});
}
async function reconcile(c,provider){
 const view=await pinnedView(c);
 if(!view.intent){console.log('NO_SETTLEMENT_INTENT: Nothing has been submitted or journaled.');return;}
 const op=operatorWallet(provider),d=await deployed(provider,op.address);
 if(view.intent.contractAddress?.toLowerCase()!==d.saved.contract.toLowerCase())throw Error('Recorded intent bound to a different contract');
 const settlement=view.attempts.find(x=>x.transactionIdentity==='B28_SETTLEMENT');
 const approval=view.attempts.find(x=>x.transactionIdentity==='B28_APPROVAL');
 if(approval){
  const receipt=await provider.getTransactionReceipt(approval.txHash);
  if(receipt?.status===1){
   await verifyApproval(provider,approval.txHash,view.allocation.buyerAddress,d.saved.contract,view.allocation.amountBaseUnits);
   if(approval.status!=='CONFIRMED')await updateAttempt(c,{id:approval.id,status:'CONFIRMED',intentStatus:'READY'});
  }
  else console.log('APPROVAL_NOT_CONFIRMED; do not re-broadcast blindly.');
 }
 if(!settlement){
  console.log(JSON.stringify({state:'NO_SETTLEMENT_BROADCAST',intentStatus:view.intent.status,approvalHash:approval?.txHash??null,resumeEligible:approval?.status==='CONFIRMED'&&view.intent.status==='READY'},null,2));return;
 }
 const receipt=await provider.getTransactionReceipt(settlement.txHash);
 if(!receipt){console.log('SETTLEMENT_OUTCOME_UNKNOWN; no automatic retry. TX hash:',settlement.txHash);return;}
 if(receipt.status!==1){console.log('SETTLEMENT_REVERTED; inspect and reconcile manually. TX hash:',settlement.txHash);return;}
 const proof=await verifySettlement(provider,{hash:settlement.txHash,contract:d.saved.contract,allocation:view.allocation,allocations:view.allocations,expectedDigest:view.intent.id,operator:op.address});
 if(view.intent.status==='CONFIRMED'){
  if(view.evidence.length!==1||view.evidence[0].txHash!==settlement.txHash||view.evidence[0].verificationStatus!=='VERIFIED')throw Error('Recorded payment evidence mismatch');
  console.log('PASS: Recorded payment independently verified on Hedera:',settlement.txHash);return;
 }
 if(view.evidence.length)throw Error('Existing evidence conflicts with unconfirmed intent');
 await recordReceipt(c,{settlementId:view.intent.id,attemptId:settlement.id,txHash:settlement.txHash,blockHash:proof.blockHash,logIndex:proof.settlementLogIndex,allocation:view.allocation,contract:d.saved.contract,token:TOKEN});
 console.log('PASS: On-chain payment reconciled and recorded:',settlement.txHash);
}
async function main(){
 const opts=args(process.argv.slice(2));
 console.log('=== B28 INTEGRATED HEDERA TESTNET SETTLEMENT ===');
 const c=await connect();
 try{
  if(opts.mode==='setup'){
   if(opts.confirm!=='B28_SETTLEMENT_ROLE_SETUP')throw Error('Explicit database role setup confirmation required');
   await setupRole(c);console.log('PASS: NOLOGIN B28 settlement writer role configured; no blockchain operation.');return;
  }
  const provider=await rpc();
  if(opts.mode==='deploy'){if(opts.confirm!=='DEPLOY_VERSIONED_HALF_EVEN_CONTRACT')throw Error('Deployment confirmation required');await deploy(provider);return;}
  if(opts.mode==='reconcile-deployment'){await reconcileDeployment(provider);return;}
  if(opts.mode==='preflight'){await preflight(provider,c);return;}
  if(opts.mode==='execute'||opts.mode==='resume'){await execute(c,provider,opts,opts.mode==='resume');return;}
  if(opts.mode==='reconcile'){await reconcile(c,provider);return;}
 }finally{await c.end().catch(()=>{});}
}
main().catch(e=>{console.error('B28 STOP:',safeMessage(e));console.error('If any transaction was journaled or broadcast, do not retry --mode=execute. Use --mode=reconcile first.');process.exitCode=1;});
