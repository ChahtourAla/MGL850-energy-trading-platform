/** B25 read-only local evidence inspection. This module never submits or records payments. */
import {Interface, Contract, getAddress, keccak256} from '../../../packages/contracts/node_modules/ethers/lib.esm/index.js';
import {assertLocalChainSession} from './b24-local-chain-session.mjs';
import {currentOutcome,recordOutcome} from './b25-outcome-history.mjs';
import {withLocalTimeout} from './b24-local-timeout.mjs';

const settlement = new Interface([
 'function settle((address token,bytes32 marketId,bytes32 snapshotHash,bytes32 planCommitment,bytes32 allocationId,address buyer,address seller,uint256 quantityWh,uint256 unitPriceMicrousdPerKwh,uint256 amountBaseUnits,bytes32 algorithmId,bytes32 pricingPolicyId,uint256 nonce,uint256 deadline) s,bytes signature)',
 'event EnergyPaymentSettled(bytes32 indexed settlementId,bytes32 indexed marketId,bytes32 indexed allocationId,bytes32 snapshotHash,bytes32 planCommitment,address buyer,address seller,address token,uint256 quantityWh,uint256 unitPriceMicrousdPerKwh,uint256 amountBaseUnits,bytes32 algorithmId,bytes32 pricingPolicyId,uint256 nonce)',
 'function executedSettlements(bytes32) view returns(bool)',
 'function paidAllocations(bytes32) view returns(bool)',
 'function usedNonces(address,uint256) view returns(bool)',
 'function marketPlans(bytes32) view returns(bytes32)',
 'function marketSnapshots(bytes32) view returns(bytes32)'
]);
const token = new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const sameAddress=(a,b)=>getAddress(a)===getAddress(b);
const sameHex=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const fields=['token','marketId','snapshotHash','planCommitment','allocationId','buyer','seller','quantityWh','unitPriceMicrousdPerKwh','amountBaseUnits','algorithmId','pricingPolicyId','nonce','deadline'];
function equalTerm(name,a,b){
 if(['token','buyer','seller'].includes(name))return sameAddress(a,b);
 if(['quantityWh','unitPriceMicrousdPerKwh','amountBaseUnits','nonce','deadline'].includes(name))return BigInt(a)===BigInt(b);
 return sameHex(a,b);
}
/** Context must be reconstructed from trusted database records by a separate verifier. */
export async function inspectSettlementReceipt({provider,session,reservationId,context}){
 const {terms,contract,operator,txHash,operatorNonce,signature,settlementDigest}=context;
 await assertLocalChainSession(session,{provider,reservationId,buyer:terms.buyer,token:terms.token,contract});
 const [tx,receipt]=await Promise.all([provider.getTransaction(txHash),provider.getTransactionReceipt(txHash)]);
 if(!tx||!receipt||receipt.status!==1||!tx.to||!sameHex(tx.hash,txHash)||!sameHex(receipt.hash ?? receipt.transactionHash,txHash)||!sameAddress(tx.to,contract)||!sameAddress(tx.from,operator)||BigInt(tx.nonce)!==BigInt(operatorNonce)||tx.value!==0n)throw Error('Settlement transaction or receipt mismatch');
 const block=await provider.send('eth_getBlockByNumber',['0x'+BigInt(receipt.blockNumber).toString(16),false]);
 if(!block||!sameHex(block.hash,receipt.blockHash))throw Error('Settlement receipt is not canonical');
 let call;try{call=settlement.parseTransaction({data:tx.data,value:tx.value});}catch{throw Error('Invalid settlement calldata');}
 if(!call||call.name!=='settle'||!sameHex(call.args.signature,signature)||fields.some(f=>!equalTerm(f,call.args.s[f],terms[f])))throw Error('Settlement calldata terms mismatch');
 const payments=[], transfers=[];
 for(const log of receipt.logs){
  if(sameAddress(log.address,contract)){
   let e;try{e=settlement.parseLog(log);}catch{continue;}
   if(e?.name==='EnergyPaymentSettled'&&sameHex(e.args.settlementId,settlementDigest)&&fields.filter(f=>f!=='deadline').every(f=>equalTerm(f,e.args[f],terms[f])))payments.push(log);
  }else if(sameAddress(log.address,terms.token)){
   let e;try{e=token.parseLog(log);}catch{continue;}
   if(e?.name==='Transfer'&&sameAddress(e.args.from,terms.buyer)&&sameAddress(e.args.to,terms.seller)&&e.args.value===BigInt(terms.amountBaseUnits))transfers.push(log);
  }
 }
 if(payments.length!==1||transfers.length!==1)throw Error('Settlement or token transfer event missing or ambiguous');
 const contractView=new Contract(contract,settlement,provider);
 const [executed,paid,nonce,plan,snapshot]=await Promise.all([contractView.executedSettlements(settlementDigest),contractView.paidAllocations(terms.allocationId),contractView.usedNonces(terms.buyer,terms.nonce),contractView.marketPlans(terms.marketId),contractView.marketSnapshots(terms.marketId)]);
 if(!executed||!paid||!nonce||!sameHex(plan,terms.planCommitment)||!sameHex(snapshot,terms.snapshotHash))throw Error('Settlement replay state mismatch');
 await assertLocalChainSession(session,{provider,reservationId,buyer:terms.buyer,token:terms.token,contract});
 const finalBlock=await provider.send('eth_getBlockByNumber',['0x'+BigInt(receipt.blockNumber).toString(16),false]);
 if(!finalBlock||!sameHex(finalBlock.hash,receipt.blockHash))throw Error('Settlement receipt is not canonical');
 return {transactionHash:tx.hash,blockHash:receipt.blockHash,blockNumber:receipt.blockNumber,settlementLogIndex:payments[0].index,transferLogIndex:transfers[0].index,simulationOnly:true};
}
/** Independently retrieves the recorded attempt and commits evidence only after chain verification.
 * The authenticated verifier and its provider are trusted; SQL cannot verify an RPC receipt.
 */
export async function verifyAndRecordLocalSettlement({client,provider,session,attemptId}){
 const target=client?.connectionParameters;
 if(target?.host!=='127.0.0.1'||target?.database!=='b22_disposable_review'||target?.user!=='b25_verifier')throw Error('Refusing non-disposable B25 verifier');
 const x=(await client.query('SELECT "b25_receipt_context"($1) context',[attemptId])).rows[0]?.context;
 if(!x||x.sessionId!==session?.id)throw Error('B25 receipt context invalid');
 const {verifyRecordedAuthorization}=await import('./b24-signature-verification.mjs');
 if(!verifyRecordedAuthorization(x,x.signature))throw Error('B25 recorded signature invalid');
 const tx=await withLocalTimeout(provider.getTransaction(x.transactionHash));
 const {keccak256}=await import('../../../packages/contracts/node_modules/ethers/lib.esm/index.js');
 if(!tx||keccak256(tx.data).toLowerCase()!==x.calldataHash)throw Error('B25 calldata commitment mismatch');
 const evidence=await withLocalTimeout(inspectSettlementReceipt({provider,session,reservationId:x.reservationId,context:{terms:x.terms.terms,contract:x.contractAddress,operator:x.operatorAddress,operatorNonce:x.operatorNonce,txHash:x.transactionHash,signature:x.signature,settlementDigest:x.settlementId}}));
 const previous=await currentOutcome(client,attemptId);
 const stored=await recordOutcome(client,attemptId,'SUCCESS',evidence,previous);
 if(!stored)throw Error('B25 evidence persistence failed');
 return {state:'CONFIRMED_LOCAL',...evidence,...stored,evidenceId:stored.eventId,realHederaExecutionAuthorized:false};
}

/** Validate a mined revert from trusted attempt context, without treating a timeout as failure. */
export async function inspectRevertedSettlement({provider,session,reservationId,context}){
 const {terms,contract,operator,txHash,operatorNonce,signature,settlementDigest,calldataHash}=context;
 await assertLocalChainSession(session,{provider,reservationId,buyer:terms.buyer,token:terms.token,contract});
 const [tx,receipt]=await Promise.all([provider.getTransaction(txHash),provider.getTransactionReceipt(txHash)]);
 if(!tx||!receipt||receipt.status!==0||!tx.to||!sameHex(tx.hash,txHash)||!sameHex(receipt.hash ?? receipt.transactionHash,txHash)||!sameAddress(tx.to,contract)||!sameAddress(tx.from,operator)||BigInt(tx.nonce)!==BigInt(operatorNonce)||tx.value!==0n||!sameHex(keccak256(tx.data),calldataHash))throw Error('Reverted transaction identity mismatch');
 const block=await provider.send('eth_getBlockByNumber',['0x'+BigInt(receipt.blockNumber).toString(16),false]);
 if(!block||!sameHex(block.hash,receipt.blockHash))throw Error('Reverted receipt is not canonical');
 let call;try{call=settlement.parseTransaction({data:tx.data,value:tx.value});}catch{throw Error('Invalid reverted calldata');}
 if(!call||call.name!=='settle'||!sameHex(call.args.signature,signature)||fields.some(f=>!equalTerm(f,call.args.s[f],terms[f])))throw Error('Reverted calldata terms mismatch');
 if(receipt.logs.length!==0)throw Error('Reverted receipt contains unexpected logs');
 const view=new Contract(contract,settlement,provider),at={blockTag:receipt.blockNumber};
 if(await view.executedSettlements(settlementDigest,at)||await view.paidAllocations(terms.allocationId,at))throw Error('Reverted transaction conflicts with paid state');
 await assertLocalChainSession(session,{provider,reservationId,buyer:terms.buyer,token:terms.token,contract});
 const finalBlock=await provider.send('eth_getBlockByNumber',['0x'+BigInt(receipt.blockNumber).toString(16),false]);
 if(!finalBlock||!sameHex(finalBlock.hash,receipt.blockHash))throw Error('Reverted receipt is not canonical');
 return {transactionHash:tx.hash,blockHash:receipt.blockHash,blockNumber:receipt.blockNumber,simulationOnly:true};
}
