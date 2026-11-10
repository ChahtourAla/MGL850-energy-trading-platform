/**
 * B15 one-package read-only chain-to-Prisma Trade projection and guarded sync.
 * Default PREVIEW; --sync performs ONLY the database Trade insert/status promotion.
 * No raw signed transaction, private key, token mint, approval or blockchain write.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHederaContractReader, loadVerifiedContractArtifacts, parseKnownReceiptLogs } from './b13-contract-client.mjs';
import { assertStoredMatch, externalTradeId, assertExistingChainMatches } from './b14-trade-core.mjs';
import {
  b15Args, requireB15, B15_OPERATIONS, B15_STATUS, validateB15Journal, validateB15Trade,
  validateB15Receipts, validateB15Calls, validateB15EscrowBalances, parseB15TradeModel, b15Projection,
  b15Compare, b15SafeUpdate,
} from './b15-trade-sync-core.mjs';

const SCHEMA=fileURLToPath(new URL('../../../database/schema.prisma',import.meta.url));
const display=(data)=>JSON.stringify(data,(k,v)=>typeof v==='bigint'?v.toString():v instanceof Date?v.toISOString():v,2);
function safeStop(error) {
  // ethers RPC errors may contain raw transactions or URL query parameters; never echo them.
  const message=error instanceof Error?error.message:'Unexpected error';
  if(/0x[0-9a-fA-F]{130,}/.test(message))return 'RPC or database error; details suppressed to avoid private data';
  if(/(?:rpc|prisma|database|connection|fetch|request failed|timeout|ECONN)/i.test(message))return 'RPC/DB operation failed; inspect connectivity without exposing secrets';
  return message.replace(/(?:postgres(?:ql)?|https?):\/\/[^\s)\]]+/ig,'[REDACTED_URL]').slice(0,350);
}
async function makeRuntime(){
  requireB15(process.env.HEDERA_NETWORK==='testnet'&&process.env.HEDERA_TESTNET_RPC_URL&&process.env.DATABASE_URL,
    'HEDERA_NETWORK=testnet, HEDERA_TESTNET_RPC_URL and DATABASE_URL required');
  const [{PrismaPg},{PrismaClient}]=await Promise.all([import('@prisma/adapter-pg'),import('../dist/generated/prisma/client.js')]);
  const prisma=new PrismaClient({adapter:new PrismaPg({connectionString:process.env.DATABASE_URL})});
  const reader=createHederaContractReader({rpcUrl:process.env.HEDERA_TESTNET_RPC_URL});
  try {
    const deployed=await reader.verifyDeployment();
    requireB15(deployed.chainId===296&&deployed.tokenDecimals===6&&deployed.tokenSymbol==='TEUSD',
      'Deployed Hedera chain or token differs from B14');
    const artifacts=loadVerifiedContractArtifacts();
    const model=parseB15TradeModel(readFileSync(SCHEMA,'utf8'));
    return {prisma,reader,artifacts,model};
  }catch(e){reader.close();await prisma.$disconnect();throw e;}
}
async function loadEvidence(rt,matchId){
  const {prisma,reader,artifacts}=rt;
  const match=await prisma.match.findUnique({where:{id:matchId}});
  requireB15(match?.status==='SELECTED','B12 match must exist and remain SELECTED');
  const run=await prisma.matchingRun.findUnique({where:{timeSlot:match.timeSlot}});
  requireB15(run,'Matching run for B12 time slot missing');
  const [rows,energyRecords,buyerWallet,sellerWallet,buyerProfile,journal]=await Promise.all([
    prisma.match.findMany({where:{timeSlot:match.timeSlot}}),
    prisma.energyRecord.findMany({where:{snapshotId:run.snapshotId}}),
    prisma.wallet.findUnique({where:{userId:match.buyerId}}),
    prisma.wallet.findUnique({where:{userId:match.sellerId}}),
    prisma.user.findUnique({where:{id:match.buyerId},select:{id:true,preferredEnergyType:true}}),
    prisma.b14TransactionIntent.findMany({where:{matchId:match.id}}),
  ]);
  const terms=assertStoredMatch({match,run,rows,energyRecords,buyerWallet,sellerWallet,buyerProfile});
  const extId=externalTradeId(matchId,artifacts.EnergyTradingEscrow.address);
  const [hbar, mint, approval, created, funded]=B15_OPERATIONS.map(op=>journal.find(j=>j.operation===op));
  requireB15(hbar&&mint&&approval&&created&&funded,'Missing B14 journal operations');
  // Operator and minter MUST originate from the already-confirmed B14 journal.
  const operator=hbar.signerAddress,admin=mint.signerAddress;
  const by=validateB15Journal(journal,{matchId,externalId:extId,buyer:terms.buyer,operator,admin,
    token:artifacts.TestEnergyUSD.address,escrow:artifacts.EnergyTradingEscrow.address});
  const {provider,token,interfaces}=await reader.getConnection();
  const id=await reader.getOnChainTradeId(extId);
  requireB15(id!=='0','B14 external trade ID not created on chain');
  const trade=await reader.getTrade(id);
  const window=validateB15Trade(trade,{externalId:extId,terms,onChainId:id});
  assertExistingChainMatches(trade,terms,extId);
  const [buyerBalance,allowance,escrowBalance]=await Promise.all([
    token.balanceOf(terms.buyer),token.allowance(terms.buyer,artifacts.EnergyTradingEscrow.address),
    token.balanceOf(artifacts.EnergyTradingEscrow.address),
  ]);
  validateB15EscrowBalances({buyerBalance,allowance,escrowBalance,amount:terms.totalAmountMicrousd});
  const checks=await Promise.all(B15_OPERATIONS.map(async op=>{
    const hash=by.get(op).txHash;
    const receipt=await provider.getTransactionReceipt(hash);
    requireB15(receipt?.status===1,`${op} has no successful receipt; never infer confirmation`);
    return [op,receipt,parseKnownReceiptLogs(receipt,artifacts,interfaces)];
  }));
  const receipts={},eventsByOperation={};
  for(const [op,receipt,events] of checks){receipts[op]=receipt;eventsByOperation[op]=events;}
  const txs=Object.fromEntries(await Promise.all(B15_OPERATIONS.map(async op=>[
    op,await provider.getTransaction(by.get(op).txHash),
  ])));
  const callData={
    MINT_TEUSD:interfaces.TestEnergyUSD.encodeFunctionData('mint',[terms.buyer,BigInt(terms.totalAmountMicrousd)]),
    APPROVE_ESCROW:interfaces.TestEnergyUSD.encodeFunctionData('approve',[artifacts.EnergyTradingEscrow.address,BigInt(terms.totalAmountMicrousd)]),
    CREATE_TRADE:interfaces.EnergyTradingEscrow.encodeFunctionData('createTrade',[
      extId,terms.buyer,terms.seller,BigInt(terms.quantityWh),BigInt(terms.unitPriceMicrousdPerKwh),
      BigInt(trade.deliveryStart),BigInt(trade.deliveryDeadline)]),
    FUND_TRADE:interfaces.EnergyTradingEscrow.encodeFunctionData('fundTrade',[BigInt(id)]),
  };
  validateB15Calls({transactions:txs,journals:by,callData});
  receipts.FUND_BUYER_HBAR.transaction=txs.FUND_BUYER_HBAR;
  const hashes=validateB15Receipts({receipts,eventsByOperation,journals:by,terms,externalId:extId,onChainId:id,
    token:artifacts.TestEnergyUSD.address,escrow:artifacts.EnergyTradingEscrow.address,admin,operator});
  return {match,terms,extId,id,trade,window,hashes,buyerBalance,allowance,escrowBalance,
    projection:b15Projection(rt.model,{match,terms,onChainId:id,chainTrade:window,hashes,externalId:extId,
      escrow:artifacts.EnergyTradingEscrow.address,token:artifacts.TestEnergyUSD.address})};
}
function summary(e,mode,disposition){
  return {action:mode,matchId:e.match.id,externalTradeId:e.extId,chainId:296,onChainTradeId:e.id,
    chainTradeStatus:e.trade.status,buyer:e.terms.buyer,seller:e.terms.seller,
    quantityWh:e.terms.quantityWh,unitPriceMicrousdPerKwh:e.terms.unitPriceMicrousdPerKwh,
    totalAmountMicrousd:e.terms.totalAmountMicrousd,deliveryStart:e.window.deliveryStart.toISOString(),
    deliveryDeadline:e.window.deliveryDeadline.toISOString(),escrowTokenUnits:e.escrowBalance.toString(),
    buyerTokenUnits:e.buyerBalance.toString(),buyerAllowanceUnits:e.allowance.toString(),
    createTxHash:e.hashes.createHash,fundTxHash:e.hashes.fundHash,dbAction:disposition,blockchainWriteRequested:false};
}
async function writeOne(rt,args){
  // Validate RPC+B12 before taking PostgreSQL locks; repeats inside the lock to prevent stale writes.
  const e=await loadEvidence(rt,args.matchId);
  const prior=await rt.prisma.trade.findUnique({where:{matchId:args.matchId}});
  const disp=b15Compare(prior,e.projection);
  console.log('B15 PRE-SYNC VERIFIED: '+display(summary(e,'SYNC_DB_ONLY',disp)));
  const saved=await rt.prisma.$transaction(async tx=>{
    await tx.$queryRaw`SELECT 1::int AS locked FROM pg_advisory_xact_lock(296, hashtext(${args.matchId}))`;
    const locked=await tx.$queryRaw`SELECT "id" FROM "matches" WHERE "id"=${args.matchId}::uuid FOR UPDATE`;
    requireB15(Array.isArray(locked)&&locked.length===1,'B12 match disappeared during B15 sync');
    const current=await tx.trade.findUnique({where:{matchId:args.matchId}});
    const refreshed=await loadEvidence(rt,args.matchId);
    requireB15(e.extId===refreshed.extId&&e.id===refreshed.id&&e.hashes.fundHash===refreshed.hashes.fundHash,'Chain/Journals changed during B15 sync');
    const choice=b15SafeUpdate(current,refreshed.projection);
    if(choice.kind==='CREATE') {
      const row=await tx.trade.create({data:choice.data});return {kind:'CREATED',row};
    }
    if(choice.kind==='UPDATE') {
      const row=await tx.trade.update({where:{matchId:args.matchId},data:choice.data});return {kind:'UPDATED',row};
    }
    return {kind:'UNCHANGED',row:current};
  },{timeout:90000,maxWait:10000});
  console.log(`B15 SYNC COMPLETE: ${saved.kind} Prisma Trade matchId=${args.matchId} onChainTradeId=${e.id} status=${B15_STATUS}`);
  console.log('B15 SAFETY: no wallet decryption, blockchain signatures, Hedera broadcast or token movement');
}
async function verify(rt,args){
  const e=await loadEvidence(rt,args.matchId);
  const row=await rt.prisma.trade.findUnique({where:{matchId:args.matchId}});
  requireB15(row,'Missing Prisma Trade row; run --sync with exact consent');
  requireB15(b15Compare(row,e.projection)==='UNCHANGED','Prisma Trade is not in final AWAITING_DELIVERY state');
  console.log('B15 VERIFIED: '+display(summary(e,'VERIFY_READ_ONLY','UNCHANGED')));
  console.log('B15 VERIFY PASS: on-chain trade, all five B14 receipts/events and Prisma Trade are consistent; no writes');
}
async function main(){
  const args=b15Args(process.argv.slice(2));
  if(args.action==='sync')requireB15(process.env.B15_SYNC_CONFIRM==='SYNC_VERIFIED_B14_TRADE_TO_POSTGRES_ONLY',
    'Explicit consent required: B15_SYNC_CONFIRM=SYNC_VERIFIED_B14_TRADE_TO_POSTGRES_ONLY');
  const rt=await makeRuntime();
  try {
    if(args.action==='sync')return await writeOne(rt,args);
    if(args.action==='verify')return await verify(rt,args);
    const e=await loadEvidence(rt,args.matchId);
    const existing=await rt.prisma.trade.findUnique({where:{matchId:args.matchId}});
    const disposition=b15Compare(existing,e.projection);
    console.log('B15 PREVIEW: '+display(summary(e,'PREVIEW_READ_ONLY',disposition)));
    console.log('B15 PREVIEW PASS: five confirmed journal entries, receipts, exact events and funded escrow; no DB or blockchain writes');
  }finally{rt.reader.close();await rt.prisma.$disconnect();}
}
main().catch(e=>{console.error('B15 STOP: '+safeStop(e));console.error('No blockchain resubmission or Prisma data overwrite. Investigate evidence/schema before retrying.');process.exitCode=1;});
