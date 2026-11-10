/** B19 live read-only cross-layer audit for a single existing Hedera trade. */
import { createHederaContractReader, parseKnownReceiptLogs } from './b13-contract-client.mjs';
import { tradeSchemaHasChainId, validateAudit } from './b19-audit-core.mjs';
import { readFileSync } from 'node:fs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const args=process.argv.slice(2);
function fail(message){throw new Error(message)}
if(args.length!==2||args[0]!=='--match-id'||!UUID.test(args[1])) fail('Usage: node b19-audit.mjs --match-id UUID (read-only only)');
const matchId=args[1].toLowerCase();
async function audit(){
 if(process.env.HEDERA_NETWORK!=='testnet'||!process.env.DATABASE_URL||!process.env.HEDERA_TESTNET_RPC_URL)
  fail('Missing HEDERA_NETWORK=testnet, DATABASE_URL or HEDERA_TESTNET_RPC_URL');
 const [{PrismaPg},{PrismaClient}]=await Promise.all([import('@prisma/adapter-pg'),import('../dist/generated/prisma/client.js')]);
 const db=new PrismaClient({adapter:new PrismaPg({connectionString:process.env.DATABASE_URL})});
 const reader=createHederaContractReader({rpcUrl:process.env.HEDERA_TESTNET_RPC_URL});
 try {
  const deployment=await reader.verifyDeployment();
  const match=await db.match.findUnique({where:{id:matchId}});
  if(!match)fail('B12 Match not found');
  const [trade,b14,b16,b17,buyerWallet,sellerWallet]=await Promise.all([
   db.trade.findUnique({where:{matchId}}),
   db.b14TransactionIntent.findMany({where:{matchId}}),
   db.b16OracleIntent.findUnique({where:{matchId}}),
   db.b17OperatorIntent.findMany({where:{matchId}}),
   db.wallet.findUnique({where:{userId:match.buyerId}}),
   db.wallet.findUnique({where:{userId:match.sellerId}}),
  ]);
  if(!trade)fail('B15 Trade not found');
  const chainLookup=await reader.getOnChainTradeId(trade.externalTradeId);
  if(chainLookup==='0')fail('External trade ID not found on Hedera');
  const chain=await reader.getTrade(chainLookup);
  const [connection,deliveries]=await Promise.all([
    reader.getConnection(),db.deliveryRecord.findMany({where:{tradeId:trade.id}}),
  ]);
  const {provider,interfaces}=connection;
  const escrowBalance=await connection.token.balanceOf(deployment.escrowAddress);
  const receipts={};
  for(const row of b14){
   if(!row.txHash)fail('B14 receipt hash missing');
   const r=await provider.getTransactionReceipt(row.txHash);
   if(!r)fail('B14 receipt not found; RPC indexing may lag');
   receipts[row.operation]={status:r.status,hash:r.hash??r.transactionHash,from:r.from,to:r.to};
   if(row.operation==='FUND_TRADE'){
    const events=parseKnownReceiptLogs(r,reader.artifacts,interfaces);
    const good=events.filter(x=>x.contract==='EnergyTradingEscrow'&&x.event==='TradeFunded'&&
     String(x.args?.onChainTradeId)===String(chainLookup)&&String(x.args?.amount)===String(chain.totalAmountMicrousd));
    if(good.length!==1)fail('TradeFunded event does not match exact funded trade and payment amount');
   }
  }
  // Read the actual checked-out Prisma schema instead of assuming a chainId
  // field that B15 deliberately treated as optional.
  const tradeSchemaHasChainIdField=tradeSchemaHasChainId(readFileSync(
    new URL('../../../database/schema.prisma',import.meta.url),'utf8'));
  const result=validateAudit({match,trade,chain,chainLookup,chainId:deployment.chainId,deployment,
   tradeSchemaHasChainId:tradeSchemaHasChainIdField,
   buyerWallet,sellerWallet,b14,b16,b17,deliveries,escrowBalance:String(escrowBalance),receipts});
  // Every CONFIRMED B17 operator intent requires its own receipt and exact state event.
  for(const item of b17.filter(x=>x.status==='CONFIRMED')){
    if(!item.txHash)fail('Confirmed B17 intent lacks transaction hash');
    const rc=await provider.getTransactionReceipt(item.txHash);
    if(!rc||rc.status!==1||String(rc.from).toLowerCase()!==String(item.signerAddress).toLowerCase()||
      String(rc.to).toLowerCase()!==String(item.targetAddress).toLowerCase())fail('Confirmed B17 receipt does not match original signer and target');
    const events=parseKnownReceiptLogs(rc,reader.artifacts,interfaces);
    const eventName={CANCEL:'TradeCancelled',EXPIRE:'TradeExpired',REFUND:'TradeRefunded'}[item.operation];
    const matching=events.filter(x=>x.contract==='EnergyTradingEscrow'&&x.event===eventName&&String(x.args?.onChainTradeId)===String(chainLookup));
    if(matching.length!==1)fail('Confirmed B17 operation lacks its exact matching event');
    if(item.operation!=='REFUND'&&events.some(x=>x.contract==='TestEnergyUSD'&&x.event==='Transfer'))fail('Cancellation/expiration must not transfer TEUSD');
  }
  // Terminal conditions require their actual receipt + event proof (no evidence payloads returned).
  if(result.category==='SELLER_SETTLED'||result.category==='BUYER_REFUNDED'){
    const terminal=result.category==='SELLER_SETTLED'?b16:b17.find(x=>x.operation==='REFUND');
    const receipt=await provider.getTransactionReceipt(terminal.txHash);
    if(!receipt||receipt.status!==1)fail('Terminal payout/refund receipt missing or reverted');
    const logs=parseKnownReceiptLogs(receipt,reader.artifacts,interfaces);
    const event=result.category==='SELLER_SETTLED'?'TradeSettled':'TradeRefunded';
    const target=result.category==='SELLER_SETTLED'?chain.seller:chain.buyer;
    const relevant=logs.filter(x=>x.contract==='EnergyTradingEscrow'&&x.event===event&&String(x.args?.onChainTradeId)===String(chainLookup));
    const transfers=logs.filter(x=>x.contract==='TestEnergyUSD'&&x.event==='Transfer'&&
     String(x.args?.from).toLowerCase()===deployment.escrowAddress.toLowerCase()&&
     String(x.args?.to).toLowerCase()===target.toLowerCase()&&String(x.args?.value)===String(chain.totalAmountMicrousd));
    if(relevant.length!==1||transfers.length!==1||
       String(relevant[0].args?.amount)!==String(chain.totalAmountMicrousd)||
       String(relevant[0].args?.[result.category==='SELLER_SETTLED'?'seller':'buyer']).toLowerCase()!==target.toLowerCase())
      fail('Terminal payment receipt lacks exact event, recipient or token transfer');
    if(result.category==='SELLER_SETTLED'){
      const confirmed=logs.filter(x=>x.contract==='EnergyTradingEscrow'&&x.event==='DeliveryConfirmed'&&
        String(x.args?.onChainTradeId)===String(chainLookup));
      if(confirmed.length!==1||String(b16.evidenceHash).toLowerCase()!==String(chain.evidenceHash).toLowerCase())
        fail('Delivery confirmation or evidence commitment mismatch');
    }
  }
  // Deliberately no wallet keys, SQL transactions, contract signers, or HTTP POSTs.
  console.log('B19 CROSS-LAYER AUDIT PASS: '+JSON.stringify(result,null,2));
  console.log('B19 READ ONLY: no signing, network broadcast, database write, secret output, or settlement');
 }finally{reader.close();await db.$disconnect();}
}
audit().catch(e=>{let msg=String(e?.message??'Unexpected audit failure');
 if(/(?:postgres(?:ql)?|https?):\/\/[^\s)]+|0x[0-9a-f]{130,}|PRIVATE_KEY|DATABASE_URL=.*\S/i.test(msg))msg='RPC/database failure; sensitive details suppressed';
 console.error('B19 AUDIT STOP:',msg.slice(0,280));
 console.error('No replay or retry of on-chain transactions. Reconcile existing intent by hash if pending.');
 process.exitCode=1;});
