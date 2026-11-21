/** Disposable local funding only. A prepared operation is never blindly resubmitted. */
import {Contract,getAddress} from '../../../packages/contracts/node_modules/ethers/lib.esm/index.js';
import {verifySigningPreflight} from './b24a2-signing-preflight.mjs';
import {assertLocalChainSession} from './b24-local-chain-session.mjs';
import {verifyLocalReceipt} from './b24-receipt-verifier.mjs';
import {withClientLock} from './b24-client-lock.mjs';
import {recoverLocalOperation} from './b24-local-tx-recovery.mjs';
import {withLocalTimeout} from './b24-local-timeout.mjs';

const abi=['function balanceOf(address) view returns(uint256)','function mint(address,uint256)'];
export async function fundLocalReservation(args){
 const allowed=new Set(['client','preflightClient','receiptClient','provider','session','minter','reservationId','grantId']);
 if(!args||Object.keys(args).some(key=>!allowed.has(key)))throw Error('Funding terms must come from the approved reservation');
 return withClientLock(args.client,()=>fundOnce(args));
}
async function fundOnce({client,preflightClient,receiptClient,provider,session,minter,reservationId,grantId}){
 const t=client?.connectionParameters;
 if(t?.host!=='127.0.0.1'||t?.database!=='b22_disposable_review'||t?.user!=='b24_funder')throw Error('Refusing non-disposable funding target');
 if(minter?.provider!==provider)throw Error('Funding signer must use the approved local provider');
 const preflight=await verifySigningPreflight(preflightClient,{reservationId});
 if(preflight.state!=='SIMULATION_ELIGIBLE')throw Error('Funding preflight blocked');
 const q=await preflightClient.query('SELECT r."buyerAddress",r."amountBaseUnits",d."tokenAddress",d."contractAddress" FROM "B24AuthorizationReservation" r JOIN "B24Deployment" d ON d.id=r."deploymentId" WHERE r.id=$1',[reservationId]);
 if(q.rowCount!==1)throw Error('Funding reservation missing');
 const r=q.rows[0],sender=getAddress(await minter.getAddress());
 await assertLocalChainSession(session,{provider,reservationId,buyer:r.buyerAddress,token:r.tokenAddress,contract:r.contractAddress});
 const token=new Contract(r.tokenAddress,abi,provider),needed=BigInt(r.amountBaseUnits);
 await client.query('BEGIN');let op;
 try{
  await client.query("SET LOCAL idle_in_transaction_session_timeout = '20s'");
  await client.query('SELECT "b24_lock_local_funding_budget"($1)',[grantId]);
  const balance=await withLocalTimeout(token.balanceOf(r.buyerAddress)),shortfall=balance>=needed?0n:needed-balance;
  if(shortfall===0n){
   op=(await client.query('SELECT "b24_find_local_funding"($1,$2) AS operation',[reservationId,grantId])).rows[0].operation;
   if(!op){await client.query('COMMIT');return {state:'FUNDING_NOT_REQUIRED',simulationOnly:true};}
  }
  const nonce=await withLocalTimeout(provider.getTransactionCount(sender,'pending'));
  if(!Number.isSafeInteger(nonce)||nonce<0)throw Error('Funding nonce outside safe range');
  if(!op)op=(await client.query('SELECT "b24_prepare_local_funding"($1,$2,$3,$4) AS operation',[reservationId,grantId,nonce,shortfall.toString()])).rows[0].operation;
  if(getAddress(op.senderAddress)!==sender||op.sessionId!==session.id)throw Error('Funding signer or session mismatch');
  await client.query('COMMIT');
 }catch(e){await client.query('ROLLBACK');throw e;}
 if(op.reused){
  try{return {...await recoverLocalOperation({client,receiptClient,provider,session,kind:'FUNDING',operationId:op.id}),reused:true};}catch{return {state:'UNRESOLVED',operationId:op.id,reused:true,simulationOnly:true};}
 }
 // Once PREPARED is committed, failure or uncertainty never causes automatic resubmission.
 let transaction;
 try{
  await client.query('BEGIN');
  await client.query("SET LOCAL idle_in_transaction_session_timeout = '20s'");
  await client.query('SELECT "b24_lock_local_funding"($1)',[op.id]);
  await withLocalTimeout(assertLocalChainSession(session,{provider,reservationId,buyer:r.buyerAddress,token:r.tokenAddress,contract:r.contractAddress}));
  transaction=await withLocalTimeout(token.connect(minter).mint(r.buyerAddress,BigInt(op.amountBaseUnits),{nonce:Number(op.senderNonce)}));
  await client.query('SELECT "b24_submit_local_funding"($1,$2)',[op.id,transaction.hash.toLowerCase()]);
  await client.query('COMMIT');
  await withLocalTimeout(transaction.wait());
  await withLocalTimeout(verifyLocalReceipt({client:receiptClient,provider,session,kind:'FUNDING',operationId:op.id}));
  if(await token.balanceOf(r.buyerAddress)<needed)throw Error('Funded balance insufficient');
  return {state:'VERIFIED',operationId:op.id,reused:false,simulationOnly:true};
 }catch{try{await client.query('ROLLBACK');await client.query('SELECT "b24_mark_local_unresolved"($1,$2)',['FUNDING',op.id]);}catch{}return {state:'UNRESOLVED',operationId:op.id,reused:false,simulationOnly:true};}
}
