/** Read-only disposable-chain readiness; never authorizes signing or submission. */
import {Contract,getAddress} from '../../../packages/contracts/node_modules/ethers/lib.esm/index.js';
import {verifySigningPreflight} from './b24a2-signing-preflight.mjs';
import {assertLocalChainSession} from './b24-local-chain-session.mjs';
import {verifyLocalRuntime} from './b24-local-bytecode.mjs';
import {verifyRecordedAuthorization} from './b24-signature-verification.mjs';
import {inspectLocalTransaction} from './b24-receipt-verifier.mjs';
const tokenAbi=['function balanceOf(address) view returns(uint256)','function allowance(address,address) view returns(uint256)','function decimals() view returns(uint8)'];
const settlementAbi=['function paymentToken() view returns(address)','function paidAllocations(bytes32) view returns(bool)','function settlementId((address token,bytes32 marketId,bytes32 snapshotHash,bytes32 planCommitment,bytes32 allocationId,address buyer,address seller,uint256 quantityWh,uint256 unitPriceMicrousdPerKwh,uint256 amountBaseUnits,bytes32 algorithmId,bytes32 pricingPolicyId,uint256 nonce,uint256 deadline)) view returns(bytes32)'];
/** Provider is an internally supplied read-only dependency; a successful result is not a payment authorization. */
export async function inspectLocalReadiness(client,{reservationId,provider,session}){
 const preflight=await verifySigningPreflight(client,{reservationId});
 if(preflight.state!=='SIMULATION_ELIGIBLE')return {state:'BLOCKED',reason:preflight.reason,simulationOnly:true,realHederaExecutionAuthorized:false};
 const q=await client.query('SELECT r."buyerAddress",r."amountBaseUnits",r."allocationId",r."settlementId",r.terms,d."chainId",d."tokenAddress",d."contractAddress",d.status FROM "B24AuthorizationReservation" r JOIN "B24Deployment" d ON d.id=r."deploymentId" WHERE r.id=$1',[reservationId]);
 if(q.rowCount!==1||q.rows[0].status!=='TEST_FIXTURE')return {state:'BLOCKED',reason:'DEPLOYMENT_BLOCKED',simulationOnly:true,realHederaExecutionAuthorized:false};
 const x=q.rows[0],network=await provider.getNetwork();
 if(network.chainId!==31337n||x.chainId!==31337)throw Error('Unapproved local chain');
 await assertLocalChainSession(session,{provider,reservationId,buyer:x.buyerAddress,token:x.tokenAddress,contract:x.contractAddress});
 const [tokenCode,contractCode]=await Promise.all([provider.getCode(x.tokenAddress),provider.getCode(x.contractAddress)]);
 verifyLocalRuntime(tokenCode,contractCode);
 const token=new Contract(x.tokenAddress,tokenAbi,provider),settlement=new Contract(x.contractAddress,settlementAbi,provider);
 const [decimals,configuredToken,balance,allowance,paid,onChainDigest]=await Promise.all([token.decimals(),settlement.paymentToken(),token.balanceOf(x.buyerAddress),token.allowance(x.buyerAddress,x.contractAddress),settlement.paidAllocations(x.allocationId),settlement.settlementId(x.terms.terms)]);
 if(decimals!==6n||getAddress(configuredToken)!==getAddress(x.tokenAddress)||onChainDigest!==x.settlementId)throw Error('Local token, settlement or digest mismatch');
 if(paid)return {state:'BLOCKED',reason:'ALREADY_SETTLED',simulationOnly:true,realHederaExecutionAuthorized:false};
 const evidence=(await client.query('SELECT "b24_local_readiness_evidence"($1,$2) AS evidence',[reservationId,session.id])).rows[0]?.evidence;
 const result={simulationOnly:true,realHederaExecutionAuthorized:false,amountBaseUnits:x.amountBaseUnits,balanceBaseUnits:balance.toString(),allowanceBaseUnits:allowance.toString()};
 if(!evidence)return {...result,state:'BLOCKED',reason:'AUTHORIZATION_CHANGED'};
 if(evidence.unresolved)return {...result,state:'UNRESOLVED'};
 if(!evidence.signature)return {...result,state:'SIGNATURE_REQUIRED'};
 if(!verifyRecordedAuthorization(x,evidence.signature))return {...result,state:'BLOCKED',reason:'INVALID_SIGNATURE'};
 if(balance<BigInt(x.amountBaseUnits)||(evidence.fundingPresent&&!evidence.fundingVerified))return {...result,state:'FUNDING_REQUIRED'};
 if(allowance<BigInt(x.amountBaseUnits)||!evidence.allowanceVerified)return {...result,state:'ALLOWANCE_REQUIRED'};
 if(allowance>BigInt(x.amountBaseUnits))return {...result,state:'BLOCKED',reason:'ALLOWANCE_EXCEEDS_CAP'};
 try{
  const base={buyer:x.buyerAddress,token:x.tokenAddress,contract:x.contractAddress};
  if(evidence.fundingPresent){if(!evidence.fundingReceipt)throw Error('Funding evidence missing');await inspectLocalTransaction({provider,kind:'FUNDING',context:{...base,...evidence.fundingReceipt}});}
  if(!evidence.allowanceReceipt)throw Error('Allowance evidence missing');
  await inspectLocalTransaction({provider,kind:'ALLOWANCE',context:{...base,...evidence.allowanceReceipt}});
 }catch{return {...result,state:'UNRESOLVED',reason:'RECEIPT_NOT_CANONICAL'};}
 return {...result,state:'READY_FOR_LOCAL_SETTLEMENT'};
}
