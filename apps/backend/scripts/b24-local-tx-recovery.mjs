/** Locate a mined local transaction by reserved sender/nonce without broadcasting. */
import {Interface,getAddress} from '../../../packages/contracts/node_modules/ethers/lib.esm/index.js';
import {assertLocalChainSession,localSessionAnchor} from './b24-local-chain-session.mjs';
import {verifyLocalReceipt} from './b24-receipt-verifier.mjs';
const abi=new Interface(['function mint(address,uint256)','function approve(address,uint256)']);
export async function locateLocalTransaction({provider,session,reservationId,buyer,token,contract,sender,nonce,amount,kind}){
 const start=await localSessionAnchor(session,{provider,reservationId,buyer,token,contract});
 const latest=BigInt(await provider.send('eth_blockNumber',[]));
 if(latest<start||latest-start>10000n)throw Error('Local recovery block range invalid');
 const matches=[];
 for(let number=start;number<=latest;number++){
  const block=await provider.send('eth_getBlockByNumber',['0x'+number.toString(16),true]);
  if(!block||!Array.isArray(block.transactions))throw Error('Local recovery block unavailable');
  for(const tx of block.transactions){
   if(typeof tx==='string'||!tx.from||!tx.to||getAddress(tx.from)!==getAddress(sender)||BigInt(tx.nonce)!==BigInt(nonce))continue;
   if(getAddress(tx.to)!==getAddress(token)||BigInt(tx.value)!==0n)throw Error('Reserved nonce used by conflicting transaction');
   let parsed;try{parsed=abi.parseTransaction({data:tx.input,value:BigInt(tx.value)});}catch{throw Error('Reserved nonce transaction invalid');}
   if(!parsed||parsed.name!==(kind==='FUNDING'?'mint':'approve')||getAddress(parsed.args[0])!==getAddress(kind==='FUNDING'?buyer:contract)||parsed.args[1]!==BigInt(amount))throw Error('Reserved nonce used by conflicting transaction');
   matches.push(tx.hash.toLowerCase());
  }
 }
 if(matches.length>1)throw Error('Multiple transactions use reserved nonce');
 return matches[0]??null;
}

/** Reconcile a previously prepared local operation; this never submits a transaction. */
export async function recoverLocalOperation({client,receiptClient,provider,session,kind,operationId}){
 const t=client?.connectionParameters,role=kind==='FUNDING'?'b24_funder':kind==='ALLOWANCE'?'b24_allowance':null;
 if(!role||t?.host!=='127.0.0.1'||t?.database!=='b22_disposable_review'||t?.user!==role)throw Error('Refusing non-disposable recovery target');
 let op=(await client.query('SELECT "b24_local_recovery_context"($1,$2) AS context',[kind,operationId])).rows[0]?.context;
 if(!op||op.sessionId!==session?.id)throw Error('Recovery context invalid');
 await assertLocalChainSession(session,{provider,reservationId:op.reservationId,buyer:op.buyer,token:op.token,contract:op.contract});
 if(op.state==='VERIFIED'){
  try{await verifyLocalReceipt({client:receiptClient,provider,session,kind,operationId});return {state:'VERIFIED',operationId,simulationOnly:true};}
  catch{return {state:'UNRESOLVED',operationId,simulationOnly:true};}
 }
 if(!['PREPARED','SUBMITTED','UNRESOLVED'].includes(op.state))throw Error('Recovery state invalid');
 if(!op.txHash){
  const hash=await locateLocalTransaction({provider,session,reservationId:op.reservationId,buyer:op.buyer,token:op.token,contract:op.contract,sender:op.sender,nonce:op.senderNonce,amount:op.amountBaseUnits,kind});
  if(!hash)return {state:'UNRESOLVED',operationId,simulationOnly:true};
  await client.query('SELECT "b24_mark_local_unresolved"($1,$2)',[kind,operationId]);
  op=(await client.query('SELECT "b24_local_recovery_context"($1,$2) AS context',[kind,operationId])).rows[0].context;
  if(!op.txHash)await client.query('SELECT "b24_attach_local_submission"($1,$2,$3)',[kind,operationId,hash]);
 }
 try{await verifyLocalReceipt({client:receiptClient,provider,session,kind,operationId});return {state:'VERIFIED',operationId,simulationOnly:true};}
 catch{return {state:'UNRESOLVED',operationId,simulationOnly:true};}
}
