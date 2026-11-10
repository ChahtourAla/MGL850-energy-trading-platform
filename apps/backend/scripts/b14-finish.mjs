/**
 * B14 unified completion CLI. PREVIEW by default. Testnet chain 296 ONLY.
 * Supported operations: approve_escrow -> create_trade -> fund_trade.
 * All actions persist immutable intents, encrypt signed transactions BEFORE broadcasting,
 * broadcast at most once per intent, and reconcile only the existing signed hash.
 */
import { Wallet, Transaction, Interface } from 'ethers';
import { createDecipheriv } from 'node:crypto';
import { loadVerifiedContractArtifacts, createHederaContractReader, parseKnownReceiptLogs } from './b13-contract-client.mjs';
import { externalTradeId, assertStoredMatch, tradeWindow } from './b14-trade-core.mjs';
import { encryptSignedTransaction, decryptSignedTransaction, checkTransition } from './b14-intent-journal-core.mjs';
import {
  argsForFinal, validateConsent, ORDER, ACTIVE, approvedPlan, createPlan,
  fundPlan, checkJournal, checkSequence, approvePrerequisites,
  creationPrerequisites, fundingPrerequisites, checkedGasQuote,
  verifySignedEnvelope, receiptKind, receiptEffect, requireReadyForSubmit,
} from './b14-final-core.mjs';

const LOWER=(s)=>String(s).toLowerCase();
const ZERO='0x'+'0'.repeat(40);
const now=()=>BigInt(Math.floor(Date.now()/1000));
function ensure(ok,msg){if(!ok)throw new Error(msg);}
function publicDisplay(context, plan, row, args, observed={}){
  console.log('B14 FINAL CHECK: '+JSON.stringify({step:args.step,action:args.action,matchId:context.match.id,
    operation:plan.operation,journalStatus:row?.status??'NOT_STAGED',intentId:row?.id??null,
    txHash:row?.txHash??null,externalTradeId:plan.externalTradeId,
    buyer:context.terms.buyer,seller:context.terms.seller,signer:plan.signerAddress,
    target:plan.targetAddress,valueWei:plan.valueWei,calldataSelector:plan.callData.slice(0,10),
    paymentUnits:context.terms.totalAmountMicrousd,
    quantityWh:context.terms.quantityWh,deliveryStart:plan.deliveryStart??context.trade?.deliveryStart??null,
    deliveryDeadline:plan.deliveryDeadline??context.trade?.deliveryDeadline??null,
    chainTradeId:context.onChainId,chainTradeStatus:context.trade?.status??null,
    buyerBalanceUnits:context.balance.toString(),escrowAllowanceUnits:context.allowance.toString(),escrowTokenUnits:context.escrowTokenBalance.toString(),
    payloadSha256:plan.payloadSha256,...observed},null,2));
}
function safeError(error){
  // Do not log RPC errors verbatim: ethers errors may contain raw signed tx bytes.
  return error instanceof Error?error.name.slice(0,50):'UNKNOWN';
}
function readWalletEncryptionKey(env){
  const b64=env.WALLET_ENCRYPTION_KEY_B64;
  if(!/^[A-Za-z0-9+/]{43}=$/.test(b64??''))throw new Error('WALLET_ENCRYPTION_KEY_B64 missing/invalid');
  const bytes=Buffer.from(b64,'base64');
  ensure(bytes.length===32&&bytes.toString('base64')===b64,'Wallet AES key malformed');
  return bytes;
}
async function buyerSigner(wallet, userId){
  // Identical AES-256-GCM + per-user AAD to B07 WalletCryptoService.
  ensure(wallet?.keyVersion===1&&wallet?.encryptedPrivateKey&&wallet?.encryptionIv&&wallet?.encryptionAuthTag,'Existing B07 buyer wallet encrypted key missing');
  const decipher=createDecipheriv('aes-256-gcm',readWalletEncryptionKey(process.env),Buffer.from(wallet.encryptionIv,'base64'));
  decipher.setAAD(Buffer.from(`mgl850:wallet:${userId}:v${wallet.keyVersion}`,'utf8'));
  decipher.setAuthTag(Buffer.from(wallet.encryptionAuthTag,'base64'));
  const plaintext=Buffer.concat([decipher.update(Buffer.from(wallet.encryptedPrivateKey,'base64')),decipher.final()]).toString('utf8');
  const {PrivateKey}=await import('@hiero-ledger/sdk');
  const hederaKey=PrivateKey.fromString(plaintext);
  ensure(Boolean(hederaKey.publicKey.toEvmAddress()),'B07 wallet is not ECDSA secp256k1; cannot sign Ethereum transaction');
  ensure(hederaKey.publicKey.toString()===wallet.publicKey,'B07 wallet private/public key inconsistency');
  const walletSigner=new Wallet('0x'+hederaKey.toStringRaw());
  ensure(LOWER(walletSigner.address)===LOWER(wallet.evmAddress),'Decrypted buyer signing key does not match committed EVM address');
  return walletSigner;
}
async function operatorSigner(address){
  ensure(process.env.HEDERA_OPERATOR_PRIVATE_KEY,'HEDERA_OPERATOR_PRIVATE_KEY required only for operator signing');
  const signer=new Wallet(process.env.HEDERA_OPERATOR_PRIVATE_KEY);
  ensure(LOWER(signer.address)===LOWER(address),'Operator private key does not match the verified operator journal signer');
  return signer;
}
async function loadRuntime(){
  ensure(process.env.HEDERA_NETWORK==='testnet'&&process.env.HEDERA_TESTNET_RPC_URL&&process.env.DATABASE_URL,'Must provide HEDERA_NETWORK=testnet, HEDERA_TESTNET_RPC_URL and DATABASE_URL');
  const artifacts=loadVerifiedContractArtifacts();
  const [{PrismaPg},{PrismaClient}]=await Promise.all([import('@prisma/adapter-pg'),import('../dist/generated/prisma/client.js')]);
  const prisma=new PrismaClient({adapter:new PrismaPg({connectionString:process.env.DATABASE_URL})});
  const reader=createHederaContractReader({rpcUrl:process.env.HEDERA_TESTNET_RPC_URL});
  try { const deployed=await reader.verifyDeployment();
    ensure(deployed.chainId===296&&deployed.tokenDecimals===6&&deployed.tokenSymbol==='TEUSD'&&!deployed.escrowPaused,'Canonical Testnet contracts changed or escrow paused');
    return {artifacts,prisma,reader,deployed};
  }catch(e){reader.close();await prisma.$disconnect();throw e;}
}
async function loadTrade(rt,args){
  const {prisma,reader,artifacts}=rt;
  const match=await prisma.match.findUnique({where:{id:args.matchId}});
  ensure(match,'Committed B12 match missing');
  const run=await prisma.matchingRun.findUnique({where:{timeSlot:match.timeSlot}});
  ensure(run,'B12 matching run missing');
  const [rows,energies,buyerWallet,sellerWallet,buyerProfile,journals,localTrade]=await Promise.all([
    prisma.match.findMany({where:{timeSlot:match.timeSlot}}),
    prisma.energyRecord.findMany({where:{snapshotId:run.snapshotId}}),
    prisma.wallet.findUnique({where:{userId:match.buyerId}}),
    prisma.wallet.findUnique({where:{userId:match.sellerId}}),
    prisma.user.findUnique({where:{id:match.buyerId},select:{id:true,preferredEnergyType:true}}),
    prisma.b14TransactionIntent.findMany({where:{matchId:match.id}}),
    prisma.trade.findUnique({where:{matchId:match.id}}),
  ]);
  const terms=assertStoredMatch({match,run,rows,energyRecords:energies,buyerWallet,sellerWallet,buyerProfile});
  ensure(buyerWallet?.hederaAccountId&&sellerWallet?.hederaAccountId,'B07 buyer/seller must have verified Hedera accounts');
  const extId=externalTradeId(match.id,artifacts.EnergyTradingEscrow.address);
  const {provider,token,escrow,interfaces}=await reader.getConnection();
  const onChainId=await reader.getOnChainTradeId(extId);
  const [balance,allowance,hbar,escrowHbar,escrowTokenBalance]=await Promise.all([
    token.balanceOf(terms.buyer),token.allowance(terms.buyer,artifacts.EnergyTradingEscrow.address),
    provider.getBalance(terms.buyer),provider.getBalance(artifacts.EnergyTradingEscrow.address),
    token.balanceOf(artifacts.EnergyTradingEscrow.address),
  ]);
  const trade=onChainId==='0'?null:await reader.getTrade(onChainId);
  return {match,run,terms,extId,buyerWallet,sellerWallet,journals,localTrade,provider,token,escrow,interfaces,onChainId,trade,balance,allowance,hbar,escrowHbar,escrowTokenBalance};
}
async function requirePriorOnChain(c, rt, step){
  const journal=new Map(c.journals.map(r=>[r.operation,r]));
  for(const operation of ['FUND_BUYER_HBAR','MINT_TEUSD']){
    const r=journal.get(operation);
    ensure(r?.status==='CONFIRMED'&&r.confirmedAt instanceof Date&&r.txHash,'Previous HBAR and TEUSD operations must be journal-confirmed');
    const receipt=await c.provider.getTransactionReceipt(r.txHash);
    ensure(receipt?.status===1,'Earlier funded transaction lacks successful on-chain receipt');
  }
  if(['CREATE_TRADE','FUND_TRADE'].includes(step)){
    const approve=journal.get('APPROVE_ESCROW');
    ensure(approve?.status==='CONFIRMED'&&approve.txHash,'Buyer APPROVE_ESCROW journal must be confirmed');
    const receipt=await c.provider.getTransactionReceipt(approve.txHash);
    ensure(receipt?.status===1,'Prior buyer approval lacks successful receipt');
  }
  if(step==='FUND_TRADE'){
    const create=journal.get('CREATE_TRADE');
    ensure(create?.status==='CONFIRMED'&&create.txHash,'CREATE_TRADE must be confirmed before escrow funding');
    const receipt=await c.provider.getTransactionReceipt(create.txHash);
    ensure(receipt?.status===1,'Prior trade creation lacks successful receipt');
  }
}
async function prepare(rt,c,args){
  const a=rt.artifacts,step=args.step;
  const prior=c.journals.find(r=>r.operation===step);
  // Operator public signer pinned to known authorized account, not an arbitrary user CLI value.
  const operator=(process.env.B14_OPERATOR_PUBLIC_ADDRESS||'0xD74a6786587A2a936cFb059fec998Ad6DB300F37').toLowerCase();
  const operatorHasRole=await rt.reader.hasOperatorRole(operator);
  let plan;
  if(step==='APPROVE_ESCROW'){
    plan=approvedPlan({matchId:c.match.id,extId:c.extId,buyer:c.terms.buyer,token:a.TestEnergyUSD.address,escrow:a.EnergyTradingEscrow.address,amount:c.terms.totalAmountMicrousd});
  }else if(step==='CREATE_TRADE'){
    // Stage requires a genuinely future delivery. After staging, keep the identical
    // immutable window even when time passes (for safe resume/reconciliation).
    const isNew=!prior && ['PREVIEW','STAGE'].includes(args.action);
    const startMs=Date.parse(args.deliveryStart);
    ensure(Number.isFinite(startMs),'Invalid delivery-start timestamp');
    const reference=isNew?new Date():new Date(startMs-60*60*1000);
    const window=tradeWindow(args.deliveryStart,reference);
    plan=createPlan({matchId:c.match.id,extId:c.extId,operator,escrow:a.EnergyTradingEscrow.address,buyer:c.terms.buyer,seller:c.terms.seller,
      quantity:c.terms.quantityWh,price:c.terms.unitPriceMicrousdPerKwh,window,iface:new Interface(a.EnergyTradingEscrow.abi)});
  }else{
    ensure(c.onChainId!=='0','Cannot fund nonexistent on-chain trade');
    plan=fundPlan({matchId:c.match.id,extId:c.extId,operator,escrow:a.EnergyTradingEscrow.address,tradeId:c.onChainId,iface:new Interface(a.EnergyTradingEscrow.abi)});
  }
  const disposition=checkJournal(prior,plan);
  return {plan,prior,disposition,operator,operatorHasRole};
}
async function checkPrereqs(rt,c,args,checked){
  await requirePriorOnChain(c,rt,args.step);
  checkSequence(c.journals,args.step,args.action);
  ensure(c.match.status==='SELECTED','Committed match is no longer SELECTED');
  const amount=c.terms.totalAmountMicrousd;
  if(args.step==='APPROVE_ESCROW'){
    approvePrerequisites({balance:c.balance,allowance:c.allowance,amount,hbar:c.hbar,tradeId:c.onChainId,localTrade:c.localTrade,escrowPaused:rt.deployed.escrowPaused});
  }else if(args.step==='CREATE_TRADE'){
    creationPrerequisites({balance:c.balance,allowance:c.allowance,amount,tradeId:c.onChainId,localTrade:c.localTrade,escrowPaused:rt.deployed.escrowPaused,operatorHasRole:checked.operatorHasRole});
  }else{
    fundingPrerequisites({trade:c.trade,expected:c.terms,externalId:c.extId,amount,balance:c.balance,allowance:c.allowance,
      paused:rt.deployed.escrowPaused,operatorHasRole:checked.operatorHasRole,nowSeconds:now()});
  }
}
async function locked(rt,c,plan,fn){
  return rt.prisma.$transaction(async tx=>{
    // All B14 sign/submit mutation paths acquire the SAME signer-level advisory lock.
    await tx.$queryRaw`SELECT 1::int AS locked FROM pg_advisory_xact_lock(296,hashtext(${plan.signerAddress}))`;
    const matches=await tx.$queryRaw`SELECT "id" FROM "matches" WHERE "id"=${c.match.id}::uuid FOR UPDATE`;
    ensure(Array.isArray(matches)&&matches.length===1,'Matched source row vanished');
    const existing=await tx.b14TransactionIntent.findUnique({where:{matchId_operation:{matchId:c.match.id,operation:plan.operation}}});
    if(existing)await tx.$queryRaw`SELECT "id" FROM "b14_transaction_intents" WHERE "id"=${existing.id}::uuid FOR UPDATE`;
    return fn(tx,existing);
  },{timeout:45_000,maxWait:10_000});
}
async function assertSignerQueue(rt,plan,currentId,tx=rt.prisma){
  const others=await tx.b14TransactionIntent.findMany({where:{signerAddress:plan.signerAddress,
    status:{in:ACTIVE},...(currentId?{id:{not:currentId}}:{})},select:{id:true,operation:true,status:true}});
  ensure(others.length===0,'A different unsettled signed transaction uses this signer; reconcile it first');
}
async function getNonceQuote(c,plan,step){
  const [latest,pending,balance,estimated,fee]=await Promise.all([
    c.provider.getTransactionCount(plan.signerAddress,'latest'),c.provider.getTransactionCount(plan.signerAddress,'pending'),
    c.provider.getBalance(plan.signerAddress),
    c.provider.estimateGas({from:plan.signerAddress,to:plan.targetAddress,data:plan.callData,value:0n}),
    c.provider.getFeeData(),
  ]);
  ensure(latest===pending,'Pending chain nonce does not match latest; stop and reconcile');
  ensure(fee.gasPrice,'RPC did not provide gasPrice');
  const quote=checkedGasQuote({estimate:estimated,gasPrice:fee.gasPrice,balance,step});
  return {nonce:latest,...quote};
}
async function stage(rt,c,args,checked){
  await checkPrereqs(rt,c,args,checked);
  const saved=await locked(rt,c,checked.plan,async(tx,row)=>{
    if(row){checkJournal(row,checked.plan);return {kind:'UNCHANGED',id:row.id};}
    await assertSignerQueue(rt,checked.plan,null,tx);
    const lockedMatch=await tx.match.findUnique({where:{id:c.match.id}});
    ensure(lockedMatch?.status==='SELECTED','Match status changed during staging');
    const result=await tx.b14TransactionIntent.create({data:{matchId:c.match.id,externalTradeId:c.extId,
      operation:checked.plan.operation,chainId:296,signerAddress:checked.plan.signerAddress,
      targetAddress:checked.plan.targetAddress,payloadSha256:checked.plan.payloadSha256,status:'PLANNED'}});
    return {kind:'CREATED',id:result.id};
  });
  console.log(`B14 FINAL STAGED: ${checked.plan.operation} ${saved.kind} intent=${saved.id} status=PLANNED; no signature or broadcast`);
}
async function seal(rt,c,args,checked){
  await checkPrereqs(rt,c,args,checked);
  ensure(checked.prior?.status==='PLANNED','Must stage exact intent before sealing');
  ensure(process.env.B14_SIGNED_TX_KEY_B64,'Existing transaction encryption key missing');
  // For PREVIEW, no private key is loaded. Only SEAL decrypts the existing B07 buyer wallet.
  const signer=args.step==='APPROVE_ESCROW'?await buyerSigner(c.buyerWallet,c.match.buyerId):await operatorSigner(checked.operator);
  ensure(LOWER(signer.address)===checked.plan.signerAddress,'Configured signing key mismatch');
  const quote=await getNonceQuote(c,checked.plan,args.step);
  const result=await locked(rt,c,checked.plan,async(tx,row)=>{
    ensure(row?.status==='PLANNED','Cannot sign an existing transaction twice');
    checkJournal(row,checked.plan);
    await assertSignerQueue(rt,checked.plan,row.id,tx);
    // Refresh all mutable RPC prerequisites under the DB lock before signing.
    const fresh=await loadTrade(rt,args);
    await checkPrereqs(rt,fresh,args,checked);
    const reQuote=await getNonceQuote(fresh,checked.plan,args.step);
    ensure(reQuote.nonce===quote.nonce,'Nonce changed since preview; stop');
    const raw=await signer.signTransaction({type:0,chainId:296,nonce:reQuote.nonce,to:checked.plan.targetAddress,
      data:checked.plan.callData,value:0n,gasLimit:reQuote.gasLimit,gasPrice:reQuote.gasPrice});
    const decoded=Transaction.from(raw);
    ensure(decoded.signature&&decoded.hash,'Unsigned transaction cannot be sealed');
    const predicted={...row,txHash:decoded.hash,nonce:String(reQuote.nonce)};
    verifySignedEnvelope(decoded,checked.plan,predicted);
    const bundle=encryptSignedTransaction(raw,process.env.B14_SIGNED_TX_KEY_B64,row.id);
    checkTransition(row.status,'SIGNED');
    return tx.b14TransactionIntent.update({where:{id:row.id},data:{status:'SIGNED',nonce:String(reQuote.nonce),txHash:decoded.hash,
      signedTxCiphertext:bundle.ciphertext,signedTxIv:bundle.iv,signedTxTag:bundle.tag},select:{id:true,status:true,txHash:true,nonce:true}});
  });
  console.log(`B14 FINAL SEALED: operation=${args.step} intent=${result.id} nonce=${result.nonce} txHash=${result.txHash}; encrypted in PostgreSQL, NOT BROADCAST`);
}
function decodeStored(row,plan){
  ensure(row?.status&&['SIGNED','SUBMITTED','NEEDS_RECONCILIATION','CONFIRMED','REVERTED'].includes(row.status),'No signed transaction in journal');
  ensure(row.txHash&&row.nonce!==null&&row.signedTxCiphertext&&row.signedTxIv&&row.signedTxTag,'Signed transaction recovery data missing');
  const raw=decryptSignedTransaction({ciphertext:row.signedTxCiphertext,iv:row.signedTxIv,tag:row.signedTxTag},process.env.B14_SIGNED_TX_KEY_B64,row.id);
  const tx=Transaction.from(raw);
  verifySignedEnvelope(tx,plan,row);
  return {raw,tx};
}
async function submit(rt,c,args,checked){
  await checkPrereqs(rt,c,args,checked);
  const row=checked.prior;
  ensure(row?.status==='SIGNED','Only SIGNED intents may broadcast; never resend a SUBMITTED transaction');
  const signed=decodeStored(row,checked.plan);
  const [chainTx,chainReceipt,latest,pending]=await Promise.all([
    c.provider.getTransaction(row.txHash),c.provider.getTransactionReceipt(row.txHash),
    c.provider.getTransactionCount(checked.plan.signerAddress,'latest'),c.provider.getTransactionCount(checked.plan.signerAddress,'pending'),
  ]);
  ensure(!chainReceipt&&!chainTx,'Exact signed transaction already visible; reconcile, do not submit');
  requireReadyForSubmit({row,plan:checked.plan,nonceLatest:latest,noncePending:pending,chainKnown:false,otherPending:false});
  // Commit SUBMITTED before making the only network send attempt.
  await locked(rt,c,checked.plan,async(tx,current)=>{
    ensure(current?.status==='SIGNED','Another process changed journal status before broadcast');
    checkJournal(current,checked.plan);
    await assertSignerQueue(rt,checked.plan,current.id,tx);
    const [freshLatest,freshPending,known,receipt]=await Promise.all([
      c.provider.getTransactionCount(checked.plan.signerAddress,'latest'),c.provider.getTransactionCount(checked.plan.signerAddress,'pending'),
      c.provider.getTransaction(current.txHash),c.provider.getTransactionReceipt(current.txHash),
    ]);
    requireReadyForSubmit({row:current,plan:checked.plan,nonceLatest:freshLatest,noncePending:freshPending,chainKnown:!!known||!!receipt,otherPending:false});
    checkTransition('SIGNED','SUBMITTED');
    await tx.b14TransactionIntent.update({where:{id:current.id},data:{status:'SUBMITTED',lastError:null}});
  });
  console.log(`B14 FINAL CLAIMED: ${args.step} status=SUBMITTED txHash=${row.txHash}; one network attempt follows`);
  try {
    const got=await c.provider.send('eth_sendRawTransaction',[signed.raw]);
    ensure(LOWER(got)===LOWER(row.txHash),'RPC returned a different hash; outcome uncertain');
    console.log(`B14 FINAL RELAY ACCEPTED: ${args.step} hash=${row.txHash}`);
  }catch(err){
    const errorCode=safeError(err);
    try {await locked(rt,c,checked.plan,async(tx,current)=>{
      if(current?.status==='SUBMITTED')await tx.b14TransactionIntent.update({where:{id:current.id},data:{status:'NEEDS_RECONCILIATION',lastError:`Uncertain relay outcome ${errorCode}`}});
    });}catch{console.error('B14 WARNING: could not persist uncertain outcome, inspect PostgreSQL before continuing');}
    throw new Error('RPC broadcast outcome is uncertain. Do NOT retry --submit; use --reconcile for identical stored hash');
  }
  console.log(`B14 FINAL SUBMITTED: ${args.step}; receipt not yet verified. Reconcile exact hash only.`);
}
async function reconcile(rt,c,args,checked){
  const row=checked.prior;
  ensure(row,'No staged journal for reconciliation');
  if(row.status==='CONFIRMED'){
    console.log(`B14 FINAL ALREADY CONFIRMED: ${args.step} intent=${row.id} hash=${row.txHash}`);
    return 'CONFIRMED';
  }
  if(row.status==='PLANNED')throw new Error('Not signed: nothing to reconcile');
  ensure(row.status!=='REVERTED','Receipt already marked REVERTED; manual investigation required');
  const signed=decodeStored(row,checked.plan);
  const [receipt,networkTx]=await Promise.all([c.provider.getTransactionReceipt(row.txHash),c.provider.getTransaction(row.txHash)]);
  const result=receiptKind(receipt,networkTx,checked.plan,row.txHash);
  let next='';
  if(result==='CONFIRMED'){
    const events=parseKnownReceiptLogs(receipt,rt.artifacts,c.interfaces);
    const id=await rt.reader.getOnChainTradeId(c.extId);
    const trade=id==='0'?null:await rt.reader.getTrade(id);
    const [balance,allowance,escrowBalance]=await Promise.all([
      c.token.balanceOf(c.terms.buyer),c.token.allowance(c.terms.buyer,rt.artifacts.EnergyTradingEscrow.address),
      c.token.balanceOf(rt.artifacts.EnergyTradingEscrow.address)]);
    receiptEffect(args.step,{receipt,events,plan:checked.plan,terms:c.terms,token:rt.artifacts.TestEnergyUSD.address,
      escrow:rt.artifacts.EnergyTradingEscrow.address,chainId:296,onChainTrade:trade,
      buyerBalance:balance,allowance,escrowTokenBalance:escrowBalance});
    next='CONFIRMED';
  }else if(result==='REVERTED')next='REVERTED';
  else if(result==='PENDING')next='SUBMITTED';
  else if(row.status==='SUBMITTED')next='NEEDS_RECONCILIATION';
  else next=row.status;
  const saved=await locked(rt,c,checked.plan,async(tx,current)=>{
    ensure(current&&current.txHash===row.txHash,'Reconciliation hash changed under lock');
    if(current.status===next)return current;
    checkTransition(current.status,next);
    return tx.b14TransactionIntent.update({where:{id:current.id},data:{status:next,...(next==='CONFIRMED'?{confirmedAt:new Date(),lastError:null}:{}),
      ...(next==='NEEDS_RECONCILIATION'?{lastError:'Not visible through RPC; never automatically resubmit'}:{})}});
  });
  console.log(`B14 FINAL RECONCILED: ${args.step} ${row.status}->${saved.status} txHash=${row.txHash}; never broadcasted another transaction`);
  return saved.status;
}
async function executeStep(rt,args){
  const c=await loadTrade(rt,args);
  const checked=await prepare(rt,c,args);
  const {plan,prior}=checked;
  publicDisplay(c,plan,prior,args);
  if(args.action==='STATUS'){
    if(prior?.status==='CONFIRMED')await requirePriorOnChain(c,rt,args.step);
    return prior?.status??'NOT_STAGED';
  }
  if(args.action==='RECONCILE')return reconcile(rt,c,args,checked);
  if(args.action==='PREVIEW'){
    if(prior?.status==='CONFIRMED')console.log('B14 FINAL PREVIEW: operation already confirmed; do not create another');
    else await checkPrereqs(rt,c,args,checked);
    console.log(`B14 FINAL PREVIEW PASS: ${args.step}; no database writes/signatures/broadcast`);
    return prior?.status??'NOT_STAGED';
  }
  if(args.action==='STAGE')await stage(rt,c,args,checked);
  else if(args.action==='SEAL')await seal(rt,c,args,checked);
  else if(args.action==='SUBMIT')await submit(rt,c,args,checked);
  return args.action;
}
async function main(){
  const args=argsForFinal(process.argv.slice(2));
  validateConsent(args.action,process.env);
  const rt=await loadRuntime();
  try {await executeStep(rt,args);}
  finally {rt.reader.close();await rt.prisma.$disconnect();}
}
main().catch(e=>{
  const err=e instanceof Error?e.message:String(e);
  console.error('B14 FINAL STOP:',err.replace(/0x[0-9a-fA-F]{128,}/g,'[REDACTED SIGNED BYTES]').slice(0,600));
  console.error('Never regenerate keys, delete a journal record, change a nonce, or re-submit an uncertain transaction. Reconcile existing hash.');
  process.exitCode=1;
});
