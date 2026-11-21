/** Exact local allowances only. Prepared operations are never blindly resubmitted. */
import {Contract} from '../../../packages/contracts/node_modules/ethers/lib.esm/index.js';
import {verifySigningPreflight} from './b24a2-signing-preflight.mjs';
import {assertLocalChainSession} from './b24-local-chain-session.mjs';
import {verifyLocalReceipt} from './b24-receipt-verifier.mjs';
import {submitRegisteredLocalAllowance} from './b24-signing.mjs';
import {withClientLock} from './b24-client-lock.mjs';
import {recoverLocalOperation} from './b24-local-tx-recovery.mjs';
import {withLocalTimeout} from './b24-local-timeout.mjs';

export async function setLocalAllowance(args){
 const allowed=new Set(['client','preflightClient','receiptClient','provider','session','registry','reservationId','revoke']);
 if(!args||Object.keys(args).some(key=>!allowed.has(key))||(args.revoke!==undefined&&typeof args.revoke!=='boolean'))throw Error('Allowance terms must come from the approved reservation');
 return withClientLock(args.client,()=>setOnce(args));
}
async function setOnce({client,preflightClient,receiptClient,provider,session,registry,reservationId,revoke=false}){
 const t=client?.connectionParameters;
 if(t?.host!=='127.0.0.1'||t?.database!=='b22_disposable_review'||t?.user!=='b24_allowance')throw Error('Refusing non-disposable allowance target');
 if(!revoke){const preflight=await verifySigningPreflight(preflightClient,{reservationId});if(preflight.state!=='SIMULATION_ELIGIBLE')throw Error('Allowance preflight blocked');}
 const q=await preflightClient.query('SELECT r."buyerAddress",r."amountBaseUnits",d."tokenAddress",d."contractAddress" FROM "B24AuthorizationReservation" r JOIN "B24Deployment" d ON d.id=r."deploymentId" WHERE r.id=$1',[reservationId]);
 if(q.rowCount!==1)throw Error('Allowance reservation missing');
 const r=q.rows[0],amount=revoke?0n:BigInt(r.amountBaseUnits);
 await assertLocalChainSession(session,{provider,reservationId,buyer:r.buyerAddress,token:r.tokenAddress,contract:r.contractAddress});
 const token=new Contract(r.tokenAddress,['function allowance(address,address) view returns(uint256)'],provider);
 await token.allowance(r.buyerAddress,r.contractAddress);
 const nonce=await provider.getTransactionCount(r.buyerAddress,'pending');if(!Number.isSafeInteger(nonce)||nonce<0)throw Error('Allowance nonce outside safe range');
 await client.query('BEGIN');let op;
 try{op=(await client.query('SELECT "b24_prepare_local_allowance"($1,$2,$3,$4) AS operation',[reservationId,session.id,nonce,amount.toString()])).rows[0].operation;await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}
 if(op.reused){
  try{return {...await recoverLocalOperation({client,receiptClient,provider,session,kind:'ALLOWANCE',operationId:op.id}),reused:true};}catch{return {state:'UNRESOLVED',operationId:op.id,reused:true,simulationOnly:true};}
 }
 try{
  const tx=await submitRegisteredLocalAllowance({client,preflightClient,registry,session,operationId:op.id,provider});await withLocalTimeout(tx.wait());
  await withLocalTimeout(verifyLocalReceipt({client:receiptClient,provider,session,kind:'ALLOWANCE',operationId:op.id}));
  if(await token.allowance(r.buyerAddress,r.contractAddress)!==amount)throw Error('Allowance readback mismatch');
  return {state:'VERIFIED',operationId:op.id,reused:false,simulationOnly:true};
 }catch{try{await client.query('SELECT "b24_mark_local_unresolved"($1,$2)',['ALLOWANCE',op.id]);}catch{}return {state:'UNRESOLVED',operationId:op.id,reused:false,simulationOnly:true};}
}
