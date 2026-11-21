/** Offline-only receipt verification. This service never submits a transaction. */
import {Contract,Interface,ZeroAddress,getAddress} from '../../../packages/contracts/node_modules/ethers/lib.esm/index.js';
import {assertLocalChainSession} from './b24-local-chain-session.mjs';

const abi=new Interface(['function mint(address to,uint256 amount)','function approve(address spender,uint256 value)','function balanceOf(address) view returns(uint256)','function allowance(address,address) view returns(uint256)','event Transfer(address indexed from,address indexed to,uint256 value)','event Approval(address indexed owner,address indexed spender,uint256 value)','function MINTER_ROLE() view returns(bytes32)','function hasRole(bytes32,address) view returns(bool)']);

/** Validate actual local-chain contents; callers must derive context from trusted records. */
export async function inspectLocalTransaction({provider,context,kind}){
 if(!['FUNDING','ALLOWANCE'].includes(kind))throw Error('Unsupported receipt kind');
 const [tx,receipt]=await Promise.all([provider.getTransaction(context.txHash),provider.getTransactionReceipt(context.txHash)]);
 if(!tx||!receipt||receipt.status!==1||!tx.to||getAddress(tx.to)!==getAddress(context.token)||tx.hash.toLowerCase()!==context.txHash)throw Error('Transaction receipt invalid or unresolved');
 if(!context.sender||context.senderNonce===null||context.senderNonce===undefined||getAddress(tx.from)!==getAddress(context.sender)||BigInt(tx.nonce)!==BigInt(context.senderNonce))throw Error('Transaction sender or nonce mismatch');
 const block=await provider.send('eth_getBlockByNumber',['0x'+BigInt(receipt.blockNumber).toString(16),false]);
 if(!block||block.hash.toLowerCase()!==receipt.blockHash.toLowerCase())throw Error('Receipt block mismatch');
 let parsed;try{parsed=abi.parseTransaction({data:tx.data,value:tx.value});}catch{throw Error('Transaction calldata invalid');}
 const amount=BigInt(context.amountBaseUnits),buyer=getAddress(context.buyer),spender=getAddress(context.contract);
 if(tx.value!==0n||!parsed)throw Error('Transaction calldata invalid');
 if(kind==='FUNDING'){
  if(parsed.name!=='mint'||getAddress(parsed.args[0])!==buyer||parsed.args[1]!==amount)throw Error('Funding transaction terms mismatch');
  const token=new Contract(context.token,abi,provider);const minterRole=await token.MINTER_ROLE();
  if(!await token.hasRole(minterRole,tx.from,{blockTag:receipt.blockNumber}))throw Error('Funding sender not an authorized minter');
 }else if(parsed.name!=='approve'||getAddress(tx.from)!==buyer||getAddress(parsed.args[0])!==spender||parsed.args[1]!==amount)throw Error('Allowance transaction terms mismatch');
 const matching=[];
 for(const log of receipt.logs){
  if(getAddress(log.address)!==getAddress(context.token))continue;
  let event;try{event=abi.parseLog(log);}catch{continue;}
  if(kind==='FUNDING'&&event?.name==='Transfer'&&getAddress(event.args[0])===ZeroAddress&&getAddress(event.args[1])===buyer&&event.args[2]===amount)matching.push(log);
  if(kind==='ALLOWANCE'&&event?.name==='Approval'&&getAddress(event.args[0])===buyer&&getAddress(event.args[1])===spender&&event.args[2]===amount)matching.push(log);
 }
 if(matching.length!==1)throw Error('Expected token event missing or ambiguous');
 const token=new Contract(context.token,abi,provider);
 if(kind==='FUNDING'){
  if(receipt.blockNumber<1)throw Error('Funding receipt block invalid');
  const [before,after]=await Promise.all([token.balanceOf(buyer,{blockTag:receipt.blockNumber-1}),token.balanceOf(buyer,{blockTag:receipt.blockNumber})]);
  if(after-before!==amount)throw Error('Funding balance effect mismatch');
 }else if(await token.allowance(buyer,spender,{blockTag:receipt.blockNumber})!==amount)throw Error('Allowance effect mismatch');
 return {receipt,logIndex:matching[0].index};
}

export async function verifyLocalReceipt({client,provider,session,kind,operationId}){
 const target=client?.connectionParameters;
 if(target?.host!=='127.0.0.1'||target?.database!=='b22_disposable_review'||target?.user!=='b24_receipt_verifier')throw Error('Refusing non-disposable receipt verifier');
 if(!['FUNDING','ALLOWANCE'].includes(kind))throw Error('Unsupported receipt kind');
 const context=(await client.query('SELECT "b24_local_receipt_context"($1,$2) AS context',[kind,operationId])).rows[0]?.context;
 // Recording a receipt is reconciliation, not permission to submit a new payment.
 if(!context||!['SUBMITTED','UNRESOLVED','VERIFIED'].includes(context.state)||!context.txHash||!context.sender||context.senderNonce===null||context.senderNonce===undefined||!['TEST_FIXTURE','RETIRED'].includes(context.deploymentStatus)||context.chainId!==31337||context.sessionId!==session?.id)throw Error('Receipt context invalid');
 await assertLocalChainSession(session,{provider,reservationId:context.reservationId,buyer:context.buyer,token:context.token,contract:context.contract});
 const {receipt,logIndex}=await inspectLocalTransaction({provider,context,kind});
 await assertLocalChainSession(session,{provider,reservationId:context.reservationId,buyer:context.buyer,token:context.token,contract:context.contract});
 if(context.state==='VERIFIED')return {state:'VERIFIED_LOCAL_RECEIPT',rechecked:true,simulationOnly:true,realHederaExecutionAuthorized:false};
 const result=await client.query('SELECT "b24_record_local_receipt"($1,$2,$3,$4,$5,$6) AS id',[kind,operationId,context.txHash,receipt.blockHash.toLowerCase(),receipt.blockNumber,logIndex]);
 return {state:'VERIFIED_LOCAL_RECEIPT',evidenceId:result.rows[0].id,simulationOnly:true,realHederaExecutionAuthorized:false};
}
