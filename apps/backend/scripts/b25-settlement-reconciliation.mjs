/** Read-only market report; recorded evidence counts as paid only after live local re-verification. */
import {inspectSettlementReceipt,inspectRevertedSettlement} from './b25-settlement-receipt.mjs';
import {verifyRecordedAuthorization} from './b24-signature-verification.mjs';
import {keccak256} from '../../../packages/contracts/node_modules/ethers/lib.esm/index.js';
import {withLocalTimeout} from './b24-local-timeout.mjs';
const u=v=>{const s=String(v);if(!/^(0|[1-9][0-9]*)$/.test(s))throw Error('Invalid reconciliation integer');return BigInt(s);};
export async function reconcileLocalMarket({client,verifierClient,provider,marketId,sessions}){
 const t=client?.connectionParameters;
 if(t?.host!=='127.0.0.1'||t?.database!=='b22_disposable_review'||t?.user!=='b25_reporter')throw Error('Refusing non-disposable B25 reporter');
 const guard=await client.query("SELECT session_user actor,EXISTS(SELECT 1 FROM b22_guard.marker WHERE value='b22-isolated-test-only') guarded");
 if(guard.rows[0]?.actor!=='b25_reporter'||!guard.rows[0]?.guarded)throw Error('B25 reporter not authorized');
 if(!/^0x[0-9a-f]{64}$/.test(marketId))throw Error('Invalid market identity');
 const plan=await client.query("SELECT id FROM \"V2AllocationPlan\" WHERE \"marketId\"=$1 AND status='AUTHORITATIVE'",[marketId]);
 if(plan.rowCount!==1)throw Error('Authoritative plan missing or ambiguous');
 const q=await client.query(`SELECT a.id,a."buyerAddress",a."sellerAddress",a."quantityWh",a."amountBaseUnits",i.status AS "intentStatus",att.id AS "attemptId",b."reservationId",e.id AS "evidenceId",e."blockReference" AS "successBlockHash",o.outcome AS "currentOutcome",o."blockHash" AS "currentBlockHash",o."blockNumber" AS "currentBlockNumber",o."settlementLogIndex" AS "currentSettlementIndex",o."transferLogIndex" AS "currentTransferIndex",re.id AS "revertEvidenceId",re."blockHash" AS "revertBlockHash",re."blockNumber" AS "revertBlockNumber" FROM "V2Allocation" a JOIN "V2AllocationPlan" p ON p.id=a."planId" AND p.status='AUTHORITATIVE' LEFT JOIN "V2SettlementIntent" i ON i."allocationId"=a.id LEFT JOIN "B25LocalIntentBinding" b ON b."intentId"=i.id LEFT JOIN "B25LocalAttempt" att ON att."intentId"=i.id LEFT JOIN "V2SettlementEvidence" e ON e."settlementId"=i.id AND e."verificationStatus"='VERIFIED' LEFT JOIN "B25RevertEvidence" re ON re."attemptId"=att.id LEFT JOIN LATERAL (SELECT outcome,"blockHash","blockNumber","settlementLogIndex","transferLogIndex" FROM "B25CanonicalOutcomeEvent" WHERE "attemptId"=att.id ORDER BY sequence DESC LIMIT 1) o ON true WHERE a."marketId"=$1 ORDER BY a.id`,[marketId]);
 let wh=0n,expected=0n,paid=0n;const counts={confirmed:0,pending:0,failed:0,unresolved:0}, allocations=[];const seen=new Set();
 for(const row of q.rows){
  if(seen.has(row.id))throw Error('Duplicate settlement evidence in report');seen.add(row.id);
  const quantity=u(row.quantityWh),amount=u(row.amountBaseUnits);wh+=quantity;expected+=amount;let state='PENDING',issue=null;
  if(row.currentOutcome==='SUCCESS' && row.intentStatus==='CONFIRMED'){
   state='UNRESOLVED';issue='EVIDENCE_NOT_CURRENTLY_VERIFIED';
   try{
    const x=(await verifierClient.query('SELECT "b25_receipt_context"($1) context',[row.attemptId])).rows[0]?.context;
    const session=sessions.get(row.reservationId);
    if(!x||!session||x.allocationId!==row.id||!verifyRecordedAuthorization(x,x.signature))throw Error('Context mismatch');
    const tx=await withLocalTimeout(provider.getTransaction(x.transactionHash));if(!tx||keccak256(tx.data).toLowerCase()!==x.calldataHash)throw Error('Calldata mismatch');
    const success=await withLocalTimeout(inspectSettlementReceipt({provider,session,reservationId:x.reservationId,context:{terms:x.terms.terms,contract:x.contractAddress,operator:x.operatorAddress,operatorNonce:x.operatorNonce,txHash:x.transactionHash,signature:x.signature,settlementDigest:x.settlementId}}));
    if(success.blockHash.toLowerCase()!==row.currentBlockHash?.toLowerCase()||BigInt(success.blockNumber)!==BigInt(row.currentBlockNumber)||success.settlementLogIndex!==row.currentSettlementIndex||success.transferLogIndex!==row.currentTransferIndex)throw Error('Success evidence changed');
    state='CONFIRMED_LOCAL';issue=null;paid+=amount;
   }catch{/* preserve unresolved: a stored flag is not a current canonicality proof */}
  }else if(row.intentStatus==='REVERTED'&&row.currentOutcome==='REVERTED'){
   state='UNRESOLVED';issue='REVERT_NOT_CURRENTLY_VERIFIED';
   try{
    const x=(await verifierClient.query('SELECT "b25_receipt_context"($1) context',[row.attemptId])).rows[0]?.context,session=sessions.get(row.reservationId);
    if(!x||!session||x.allocationId!==row.id||!verifyRecordedAuthorization(x,x.signature))throw Error('Context mismatch');
    const failure=await withLocalTimeout(inspectRevertedSettlement({provider,session,reservationId:x.reservationId,context:{terms:x.terms.terms,contract:x.contractAddress,operator:x.operatorAddress,operatorNonce:x.operatorNonce,txHash:x.transactionHash,signature:x.signature,settlementDigest:x.settlementId,calldataHash:x.calldataHash}}));
    if(failure.blockHash.toLowerCase()!==row.currentBlockHash||BigInt(failure.blockNumber)!==BigInt(row.currentBlockNumber))throw Error('Revert evidence changed');
    state='FAILED';issue='REVERTED';
   }catch{/* inability to reverify is not proof of failure */}
  }else if(row.attemptId){state='UNRESOLVED';issue=row.evidenceId?'EVIDENCE_REQUIRES_RECONCILIATION':'ATTEMPT_WITHOUT_VERIFIED_EVIDENCE';}
  counts[state==='CONFIRMED_LOCAL'?'confirmed':state==='PENDING'?'pending':state==='FAILED'?'failed':'unresolved']++;
  allocations.push({allocationId:row.id,buyer:row.buyerAddress,seller:row.sellerAddress,quantityWh:quantity.toString(),expectedBaseUnits:amount.toString(),paidBaseUnits:state==='CONFIRMED_LOCAL'?amount.toString():'0',state,issue});
 }
 if(paid>expected)throw Error('Verified payment exceeds expected total');
 return {marketId,matchedWh:wh.toString(),expectedBaseUnits:expected.toString(),verifiedPaidBaseUnits:paid.toString(),unpaidBaseUnits:(expected-paid).toString(),...counts,allocations,simulationOnly:true,realHederaExecutionAuthorized:false};
}
