/** Reconcile an existing attempt without signing or broadcasting a replacement transaction. */
import {verifyAndRecordLocalSettlement,inspectRevertedSettlement} from './b25-settlement-receipt.mjs';
import {verifyRecordedAuthorization} from './b24-signature-verification.mjs';
import {assertLocalChainSession,localSessionAnchor} from './b24-local-chain-session.mjs';
import {randomUUID} from 'node:crypto';
import {getAddress} from '../../../packages/contracts/node_modules/ethers/lib.esm/index.js';
import {withLocalTimeout} from './b24-local-timeout.mjs';
import {currentOutcome,recordOutcome} from './b25-outcome-history.mjs';
export async function recoverLocalSettlement({client,provider,session,attemptId}){
 const t=client?.connectionParameters;
 if(t?.host!=='127.0.0.1'||t?.database!=='b22_disposable_review'||t?.user!=='b25_verifier')throw Error('Refusing non-disposable B25 verifier');
 const context=(await client.query('SELECT "b25_receipt_context"($1) context',[attemptId])).rows[0]?.context;
 if(!context||context.sessionId!==session?.id)throw Error('B25 recovery context invalid');
 try{await withLocalTimeout(assertLocalChainSession(session,{provider,reservationId:context.reservationId,buyer:context.buyerAddress,token:context.tokenAddress,contract:context.contractAddress}));}
 catch(error){if(/Unknown or mismatched|Stale local chain session|session retired|Unapproved local chain|runtime code mismatch/i.test(error?.message??''))throw error;return {state:'UNRESOLVED',attemptId,reason:'SESSION_CHECK_UNAVAILABLE',simulationOnly:true};}
 const previous=await currentOutcome(client,attemptId);
 if(previous&&previous.outcome!=='NONCANONICAL'){
  const historical=previous;
  let canonical;try{canonical=await withLocalTimeout(provider.send('eth_getBlockByNumber',['0x'+BigInt(historical.blockNumber).toString(16),false]));}catch{return {state:'UNRESOLVED',attemptId,reason:'RPC_UNAVAILABLE',simulationOnly:true};}
  // A provider returning null for a height that should exist is not proof of
  // a reorganization. Establish the current height before recording one.
  if(!canonical){
   let latest;
   try{latest=BigInt(await withLocalTimeout(provider.send('eth_blockNumber',[])));}
   catch{return {state:'UNRESOLVED',attemptId,reason:'RPC_UNAVAILABLE',simulationOnly:true};}
   if(latest>=BigInt(historical.blockNumber))return {state:'UNRESOLVED',attemptId,reason:'CANONICAL_BLOCK_UNAVAILABLE',simulationOnly:true};
  }else if(typeof canonical.hash!=='string'||!/^0x[0-9a-fA-F]{64}$/.test(canonical.hash)){
   return {state:'UNRESOLVED',attemptId,reason:'CANONICAL_BLOCK_UNAVAILABLE',simulationOnly:true};
  }
  if(!canonical||canonical.hash.toLowerCase()!==historical.blockHash.toLowerCase()){
   await recordOutcome(client,attemptId,'NONCANONICAL',historical,previous);
   return {state:'UNRESOLVED',attemptId,reason:'NONCANONICAL',simulationOnly:true};
  }
 }
 let receipt;
 try{receipt=await withLocalTimeout(provider.getTransactionReceipt(context.transactionHash));}catch{return {state:'UNRESOLVED',attemptId,reason:'RPC_UNAVAILABLE',simulationOnly:true};}
 if(!receipt){
  try{
   const start=await withLocalTimeout(localSessionAnchor(session,{provider,reservationId:context.reservationId,buyer:context.buyerAddress,token:context.tokenAddress,contract:context.contractAddress}));
   const latest=BigInt(await withLocalTimeout(provider.send('eth_blockNumber',[])));if(latest<start||latest-start>10000n)throw Error('Recovery range invalid');
   const scanDeadline=Date.now()+30000;
   for(let n=start;n<=latest;n++){
    if(Date.now()>=scanDeadline)throw Error('Recovery scan deadline exceeded');
    const block=await withLocalTimeout(provider.send('eth_getBlockByNumber',['0x'+n.toString(16),true]));if(!block||!Array.isArray(block.transactions))throw Error('Recovery block unavailable');
    for(const tx of block.transactions){
     if(typeof tx==='string'||!tx.from||getAddress(tx.from)!==getAddress(context.operatorAddress)||BigInt(tx.nonce)!==BigInt(context.operatorNonce))continue;
     if(tx.hash.toLowerCase()!==context.transactionHash){await client.query('SELECT "b25_record_nonce_conflict"($1,$2,$3)',[attemptId,randomUUID(),tx.hash.toLowerCase()]);return {state:'UNRESOLVED',attemptId,reason:'NONCE_CONFLICT',simulationOnly:true};}
    }
   }
  }catch{return {state:'UNRESOLVED',attemptId,reason:'RECOVERY_SCAN_UNAVAILABLE',simulationOnly:true};}
  return {state:'UNRESOLVED',attemptId,reason:'RECEIPT_UNAVAILABLE',simulationOnly:true};
 }
 if(receipt.status===0){
  try{
   if(!verifyRecordedAuthorization(context,context.signature))throw Error('Invalid recorded signature');
   const verified=await withLocalTimeout(inspectRevertedSettlement({provider,session,reservationId:context.reservationId,context:{terms:context.terms.terms,contract:context.contractAddress,operator:context.operatorAddress,operatorNonce:context.operatorNonce,txHash:context.transactionHash,signature:context.signature,settlementDigest:context.settlementId,calldataHash:context.calldataHash}}));
   const stored=await recordOutcome(client,attemptId,'REVERTED',verified,await currentOutcome(client,attemptId));
   if(!stored)throw Error('Revert evidence unavailable');
   return {state:'REVERTED_LOCAL',attemptId,...verified,...stored};
  }catch{return {state:'UNRESOLVED',attemptId,reason:'REVERT_NOT_VERIFIED',simulationOnly:true};}
 }
 try{return await verifyAndRecordLocalSettlement({client,provider,session,attemptId});}
 catch{return {state:'UNRESOLVED',attemptId,reason:'RECEIPT_NOT_VERIFIED',simulationOnly:true};}
}
