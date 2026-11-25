/** B33 read model for ANY specifically approved V2 market.
 * Keeps all financial writes inside the existing restricted B28 journal role. */
import {randomUUID} from 'node:crypto';
import {restrictedWrite} from './b28-hedera-db.mjs';
import {verifyDayMarket} from './b33-chain-core.mjs';
const hash=/^0x[0-9a-f]{64}$/;
const only=async(db,sql,args)=>{const r=(await db.query(sql,args)).rows;if(r.length!==1)throw Error('Missing or ambiguous approved V2 data');return r[0];};
export async function readApprovedMarket(db,hour,{allocationId=null,readKey=false}={}){
 await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
  const market=await only(db,'SELECT * FROM "V2Market" WHERE id=$1',[hour.marketId]);
  const snapshot=await only(db,'SELECT * FROM "V2Snapshot" WHERE "marketId"=$1',[hour.marketId]);
  const plan=await only(db,'SELECT * FROM "V2AllocationPlan" WHERE "marketId"=$1',[hour.marketId]);
  const allocations=(await db.query('SELECT * FROM "V2Allocation" WHERE "marketId"=$1 ORDER BY id',[hour.marketId])).rows;
  const measurements=(await db.query('SELECT * FROM "V2SnapshotMeasurement" WHERE "marketId"=$1',[hour.marketId])).rows;
  const positions=(await db.query('SELECT * FROM "V2Position" WHERE "marketId"=$1',[hour.marketId])).rows;
  const importRecord=await only(db,'SELECT id,payload_sha256 FROM energy_snapshot_imports WHERE id=$1',[hour.snapshotId]);
  verifyDayMarket(hour,{market,snapshot,plan,allocations,measurements,positions,importRecord});
  const selected=allocations.find(x=>x.id===(allocationId??hour.allocations[0].id));if(!selected)throw Error('Allocation not in the approved plan');
  const cols=readKey?',public_key AS "publicKey",encrypted_private_key AS "encryptedPrivateKey",encryption_iv AS "encryptionIv",encryption_auth_tag AS "encryptionAuthTag",key_version AS "keyVersion"':'';
  const wallets=(await db.query(`SELECT user_id AS "userId",evm_address AS "evmAddress",hedera_account_id AS "hederaAccountId"${cols} FROM public.wallets WHERE user_id IN ($1,$2)`,[selected.buyerId,selected.sellerId])).rows;
  const buyerWallet=wallets.find(x=>x.userId===selected.buyerId),sellerWallet=wallets.find(x=>x.userId===selected.sellerId);
  if(wallets.length!==2||!buyerWallet||!sellerWallet||buyerWallet.evmAddress?.toLowerCase()!==selected.buyerAddress.toLowerCase()||sellerWallet.evmAddress?.toLowerCase()!==selected.sellerAddress.toLowerCase())throw Error('Approved buyer/seller wallet identity mismatch');
  const intents=(await db.query('SELECT * FROM "V2SettlementIntent" WHERE "allocationId"=$1',[selected.id])).rows;
  if(intents.length>1)throw Error('Duplicate settlement intents');
  const intent=intents[0]??null;
  const attempts=intent?(await db.query('SELECT * FROM "V2SettlementAttempt" WHERE "settlementId"=$1 ORDER BY sequence',[intent.id])).rows:[];
  const evidence=intent?(await db.query('SELECT * FROM "V2SettlementEvidence" WHERE "settlementId"=$1',[intent.id])).rows:[];
  await db.query('COMMIT');
  return {market,snapshot,plan,allocations,allocation:selected,buyerWallet,sellerWallet,intent,attempts,evidence,hour};
 }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}
}
export async function initialJournal(db,{settlementId,a,contract,token,hash:txHash,nonce,kind,metadata}){
 if(!hash.test(settlementId)||!hash.test(txHash)||!['B28_APPROVAL','B28_SETTLEMENT'].includes(kind))throw Error('Invalid B33 transaction journal parameters');
 return restrictedWrite(db,async t=>{
  const prior=(await t.query('SELECT id FROM "V2SettlementIntent" WHERE "allocationId"=$1',[a.id])).rows;
  if(prior.length)throw Error('Settlement intent already exists; reconciliation only');
  await t.query('INSERT INTO "V2SettlementIntent" (id,"allocationId","marketId","chainId","tokenAddress","contractAddress","amountBaseUnits",status,"updatedAt") VALUES ($1,$2,$3,296,$4,$5,$6,\'PLANNED\',now())',[settlementId,a.id,a.marketId,token.toLowerCase(),contract.toLowerCase(),String(a.amountBaseUnits)]);
  const id=randomUUID();
  await t.query('INSERT INTO "V2SettlementAttempt" (id,"settlementId",sequence,status,"txHash","transactionIdentity",nonce,"recoveryMetadata","updatedAt") VALUES ($1,$2,1,\'SIGNED\',$3,$4,$5,$6::jsonb,now())',[id,settlementId,txHash,kind,nonce,JSON.stringify(metadata)]);
  return {id,sequence:1};
 });
}
