/** Hedera Testnet-only operations. Importing this module never broadcasts. */
import {readFile} from 'node:fs/promises';
import {createDecipheriv} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {
 AbiCoder,Contract,ContractFactory,Interface,JsonRpcProvider,Wallet,
 TypedDataEncoder,getAddress,keccak256,toUtf8Bytes,verifyTypedData
} from '../../../packages/contracts/node_modules/ethers/lib.esm/index.js';
import {ADMIN,CHAIN_ID,LEGACY_SETTLEMENT,MANIFEST_HASH,MARKET,PLAN,PRICING,SNAPSHOT_HASH,TOKEN,quoteHalfEven} from './b28-hedera-core.mjs';

export const TYPES=Object.freeze({Settlement:[
 {name:'token',type:'address'},{name:'marketId',type:'bytes32'},{name:'snapshotHash',type:'bytes32'},
 {name:'planCommitment',type:'bytes32'},{name:'allocationId',type:'bytes32'},
 {name:'buyer',type:'address'},{name:'seller',type:'address'},
 {name:'quantityWh',type:'uint256'},{name:'unitPriceMicrousdPerKwh',type:'uint256'},
 {name:'amountBaseUnits',type:'uint256'},{name:'algorithmId',type:'bytes32'},
 {name:'pricingPolicyId',type:'bytes32'},{name:'nonce',type:'uint256'},
 {name:'deadline',type:'uint256'}
]});
export const SETTLEMENT_ABI=[
 'function settle((address token,bytes32 marketId,bytes32 snapshotHash,bytes32 planCommitment,bytes32 allocationId,address buyer,address seller,uint256 quantityWh,uint256 unitPriceMicrousdPerKwh,uint256 amountBaseUnits,bytes32 algorithmId,bytes32 pricingPolicyId,uint256 nonce,uint256 deadline) s,bytes signature)',
 'function settlementId((address token,bytes32 marketId,bytes32 snapshotHash,bytes32 planCommitment,bytes32 allocationId,address buyer,address seller,uint256 quantityWh,uint256 unitPriceMicrousdPerKwh,uint256 amountBaseUnits,bytes32 algorithmId,bytes32 pricingPolicyId,uint256 nonce,uint256 deadline) s) view returns(bytes32)',
 'event EnergyPaymentSettled(bytes32 indexed settlementId,bytes32 indexed marketId,bytes32 indexed allocationId,bytes32 snapshotHash,bytes32 planCommitment,address buyer,address seller,address token,uint256 quantityWh,uint256 unitPriceMicrousdPerKwh,uint256 amountBaseUnits,bytes32 algorithmId,bytes32 pricingPolicyId,uint256 nonce)',
 'function paymentToken() view returns(address)',
 'function HALF_EVEN_POLICY_ID() view returns(bytes32)',
 'function paused() view returns(bool)',
 'function OPERATOR_ROLE() view returns(bytes32)',
 'function hasRole(bytes32,address) view returns(bool)',
 'function paidAllocations(bytes32) view returns(bool)',
 'function executedSettlements(bytes32) view returns(bool)',
 'function usedNonces(address,uint256) view returns(bool)',
 'function marketPlans(bytes32) view returns(bytes32)',
 'function marketSnapshots(bytes32) view returns(bytes32)',
];
export const TOKEN_ABI=[
 'function decimals() view returns(uint8)','function symbol() view returns(string)',
 'function balanceOf(address) view returns(uint256)','function allowance(address,address) view returns(uint256)',
 'function approve(address,uint256) returns(bool)',
 'event Transfer(address indexed from,address indexed to,uint256 value)',
 'event Approval(address indexed owner,address indexed spender,uint256 value)',
];
const settlementIface=new Interface(SETTLEMENT_ABI),tokenIface=new Interface(TOKEN_ABI);
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const secureHash=/^0x[0-9a-fA-F]{64}$/;
export const policyId=keccak256(toUtf8Bytes(PRICING));
export const algorithmId=keccak256(toUtf8Bytes('1.0.0'));
export function planCommitment(allocationIds){
 if(!Array.isArray(allocationIds)||allocationIds.length!==3||allocationIds.some(i=>!secureHash.test(i)))throw Error('Invalid complete B28 allocation set');
 const ids=allocationIds.map(i=>i.toLowerCase()).sort();
 if(new Set(ids).size!==3)throw Error('Repeated allocation identity');
 const bytes=AbiCoder.defaultAbiCoder().encode(['string','bytes32','bytes32','bytes32','bytes32[]'],['mgl850:b28:half-even-plan:1',MARKET,SNAPSHOT_HASH,MANIFEST_HASH,ids]);
 return keccak256(bytes);
}
export function settlementTerms(a,all,nonce,deadline){
 const result=quoteHalfEven(a.quantityWh,a.unitPriceMicrousdPerKwh);
 if(result.amountBaseUnits!==String(a.amountBaseUnits))throw Error('Payment amount changed');
 return {
  token:getAddress(TOKEN),marketId:MARKET,snapshotHash:SNAPSHOT_HASH,
  planCommitment:planCommitment(all.map(x=>x.id)),allocationId:a.id,
  buyer:getAddress(a.buyerAddress),seller:getAddress(a.sellerAddress),
  quantityWh:BigInt(a.quantityWh),unitPriceMicrousdPerKwh:BigInt(a.unitPriceMicrousdPerKwh),
  amountBaseUnits:BigInt(a.amountBaseUnits),algorithmId,pricingPolicyId:policyId,
  nonce:BigInt(nonce),deadline:BigInt(deadline),
 };
}
export function domain(contract){return {name:'MGL850 Energy Settlement',version:'1',chainId:CHAIN_ID,verifyingContract:getAddress(contract)};}
export function authorizationDigest(terms,contract){return TypedDataEncoder.hash(domain(contract),TYPES,terms).toLowerCase();}
export function buyerNonce(allocationId){return BigInt('0x'+keccak256(allocationId).slice(2,18));}
export function recoverBuyer(terms,contract,sig){return same(verifyTypedData(domain(contract),TYPES,terms,sig),terms.buyer);}
export async function rpc(){
 const url=process.env.HEDERA_JSON_RPC_URL;
 if(!url||!/^https:\/\//.test(url))throw Error('Missing HTTPS HEDERA_JSON_RPC_URL');
 const p=new JsonRpcProvider(url,CHAIN_ID,{staticNetwork:true});
 if((await p.getNetwork()).chainId!==296n||BigInt(await p.send('eth_chainId',[]))!==296n)throw Error('Refusing non-Hedera-Testnet RPC');
 return p;
}
export function operatorWallet(provider){
 const secret=process.env.B28_TESTNET_OPERATOR_PRIVATE_KEY;
 if(!secret||!/^0x[0-9a-fA-F]{64}$/.test(secret))throw Error('B28_TESTNET_OPERATOR_PRIVATE_KEY must be configured privately');
 return new Wallet(secret,provider);
}
export function deployerWallet(provider){
 const secret=process.env.B28_TESTNET_DEPLOYER_PRIVATE_KEY;
 if(!secret||!/^0x[0-9a-fA-F]{64}$/.test(secret))throw Error('B28_TESTNET_DEPLOYER_PRIVATE_KEY must be configured privately');
 const w=new Wallet(secret,provider);
 if(!same(w.address,ADMIN))throw Error('Wrong deployment administrator key');
 return w;
}
/** In-memory-only decrypt of *existing simulated* custodial buyer wallet. Never return it via API or persist. */
export async function simulatedBuyerWallet(record,provider){
 if(process.env.B28_ALLOW_SIMULATED_CUSTODIAL_SIGNING!=='YES')throw Error('Simulated custodial signing has not been explicitly enabled');
 const encoded=process.env.WALLET_ENCRYPTION_KEY_B64;
 if(!encoded||! /^[A-Za-z0-9+/]{43}=$/.test(encoded))throw Error('Wallet encryption configuration missing');
 const key=Buffer.from(encoded,'base64');
 if(key.length!==32||key.toString('base64')!==encoded||record.keyVersion!==1)throw Error('Invalid buyer wallet encryption configuration');
 const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(record.encryptionIv,'base64'));
 decipher.setAAD(Buffer.from(`mgl850:wallet:${record.userId}:v${record.keyVersion}`,'utf8'));
 decipher.setAuthTag(Buffer.from(record.encryptionAuthTag,'base64'));
 const pk=Buffer.concat([decipher.update(Buffer.from(record.encryptedPrivateKey,'base64')),decipher.final()]).toString('utf8');
 const {PrivateKey}=await import('@hiero-ledger/sdk');
 // Existing B07 wallets store Hedera DER-encoded ECDSA keys, not 0x-prefixed EVM secrets.
 // Use the same conversion and public-key consistency checks as B14 buyerSigner().
 const hederaKey=PrivateKey.fromString(pk);
 if(!hederaKey.publicKey.toEvmAddress())throw Error('Custodial buyer key is not ECDSA secp256k1');
 if(hederaKey.publicKey.toString()!==record.publicKey)throw Error('Decrypted buyer key mismatches persisted public key');
 const wallet=new Wallet('0x'+hederaKey.toStringRaw(),provider);
 if(!same(wallet.address,record.evmAddress))throw Error('Decrypted buyer key mismatches the approved wallet');
 return wallet;
}
export async function contractPreflight(provider,address,operator){
 if(!address||!/^0x[0-9a-fA-F]{40}$/.test(address)||same(address,LEGACY_SETTLEMENT))throw Error('New B28 versioned contract address required');
 const code=await provider.getCode(address);
 if(!code||code==='0x')throw Error('New settlement contract has no runtime bytecode');
 const settlement=new Contract(address,SETTLEMENT_ABI,provider);
 const token=new Contract(TOKEN,TOKEN_ABI,provider);
 const [paymentToken,pid,paused,role,decimals,symbol,allowed]=await Promise.all([
  settlement.paymentToken(),settlement.HALF_EVEN_POLICY_ID(),settlement.paused(),settlement.OPERATOR_ROLE(),
  token.decimals(),token.symbol(),settlement.hasRole(await settlement.OPERATOR_ROLE(),operator),
 ]);
 if(!same(paymentToken,TOKEN)||!same(pid,policyId)||paused||Number(decimals)!==6||symbol!=='TEUSD'||!allowed)throw Error('B28 contract/token/operator preflight failed');
 return {settlement,token,codeHash:keccak256(code)};
}
export async function signRawTransaction(wallet,fields){
 const tx=await wallet.populateTransaction({...fields,value:0n});
 if(BigInt(tx.chainId)!==296n||!Number.isInteger(tx.nonce)||tx.nonce<0)throw Error('Invalid Hedera nonce/chain');
 const raw=await wallet.signTransaction(tx);
 return {raw,hash:keccak256(raw).toLowerCase(),nonce:tx.nonce};
}
export async function verifyApproval(provider,hash,buyer,contract,amount){
 const receipt=await provider.getTransactionReceipt(hash),tx=await provider.getTransaction(hash);
 if(!receipt||!tx||receipt.status!==1||!same(tx.from,buyer)||!same(tx.to,TOKEN)||BigInt(tx.value)!==0n)throw Error('Buyer approval receipt not confirmed');
 const block=await provider.getBlock(receipt.blockNumber);
 if(!block||!same(block.hash,receipt.blockHash))throw Error('Approval receipt noncanonical');
 const call=tokenIface.parseTransaction({data:tx.data,value:tx.value});
 if(!call||call.name!=='approve'||!same(call.args[0],contract)||BigInt(call.args[1])!==BigInt(amount))throw Error('Approval calldata mismatch');
 const event=receipt.logs.filter(l=>same(l.address,TOKEN)).map(l=>{try{return tokenIface.parseLog(l);}catch{return null;}}).filter(e=>e?.name==='Approval'&&same(e.args.owner,buyer)&&same(e.args.spender,contract)&&BigInt(e.args.value)===BigInt(amount));
 if(event.length!==1)throw Error('Missing or ambiguous buyer allowance receipt');
 return true;
}
export async function verifySettlement(provider,{hash,contract,allocation,allocations,expectedDigest,operator}){
 const [tx,receipt]=await Promise.all([provider.getTransaction(hash),provider.getTransactionReceipt(hash)]);
 if(!tx||!receipt||receipt.status!==1||!same(tx.hash,hash)||!same(tx.to,contract)||!same(receipt.to,contract)||!same(tx.from,operator)||BigInt(tx.value)!==0n)throw Error('Settlement receipt missing, unauthorized or failed');
 const block=await provider.getBlock(receipt.blockNumber);
 if(!block||!same(block.hash,receipt.blockHash))throw Error('Noncanonical Hedera settlement receipt');
 const call=settlementIface.parseTransaction({data:tx.data,value:tx.value});
 if(!call||call.name!=='settle')throw Error('Unexpected settlement calldata');
 const terms=call.args[0],signature=call.args[1];
 const valid=settlementTerms(allocation,allocations,terms.nonce,terms.deadline);
 for(const field of TYPES.Settlement){
  const name=field.name;
  if(field.type==='uint256' ? BigInt(terms[name])!==BigInt(valid[name]) : !same(terms[name],valid[name]))throw Error('Settlement terms changed from authoritative allocation');
 }
 const digest=authorizationDigest(valid,contract);
 if(digest!==expectedDigest||!recoverBuyer(valid,contract,signature))throw Error('Buyer signature or settlement digest invalid');
 const events=[],transfers=[];
 for(const l of receipt.logs){
  if(same(l.address,contract)){
   try{const e=settlementIface.parseLog(l);if(e?.name==='EnergyPaymentSettled'&&same(e.args.settlementId,digest)&&same(e.args.marketId,MARKET)&&same(e.args.allocationId,allocation.id)&&same(e.args.snapshotHash,SNAPSHOT_HASH)&&same(e.args.planCommitment,valid.planCommitment)&&same(e.args.buyer,allocation.buyerAddress)&&same(e.args.seller,allocation.sellerAddress)&&same(e.args.token,TOKEN)&&BigInt(e.args.quantityWh)===BigInt(allocation.quantityWh)&&BigInt(e.args.unitPriceMicrousdPerKwh)===BigInt(allocation.unitPriceMicrousdPerKwh)&&BigInt(e.args.amountBaseUnits)===BigInt(allocation.amountBaseUnits)&&same(e.args.algorithmId,algorithmId)&&same(e.args.pricingPolicyId,policyId)&&BigInt(e.args.nonce)===BigInt(terms.nonce))events.push(l);}catch{}
  }
  if(same(l.address,TOKEN)){
   try{const e=tokenIface.parseLog(l);if(e?.name==='Transfer'&&same(e.args.from,allocation.buyerAddress)&&same(e.args.to,allocation.sellerAddress)&&BigInt(e.args.value)===BigInt(allocation.amountBaseUnits))transfers.push(l);}catch{}
  }
 }
 if(events.length!==1||transfers.length!==1)throw Error('Missing, duplicated or mismatched on-chain payment/Transfer event');
 const settlement=new Contract(contract,SETTLEMENT_ABI,provider);
 const [executed,paid,nonceUsed,marketPlan,marketSnapshot,onchainDigest]=await Promise.all([
  settlement.executedSettlements(digest),settlement.paidAllocations(allocation.id),settlement.usedNonces(allocation.buyerAddress,terms.nonce),settlement.marketPlans(MARKET),settlement.marketSnapshots(MARKET),settlement.settlementId(valid),
 ]);
 if(!executed||!paid||!nonceUsed||!same(marketPlan,valid.planCommitment)||!same(marketSnapshot,SNAPSHOT_HASH)||!same(onchainDigest,digest))throw Error('On-chain replay/market state inconsistent');
 const again=await provider.getBlock(receipt.blockNumber);
 if(!again||!same(again.hash,receipt.blockHash))throw Error('Payment receipt lost canonical identity');
 return {txHash:hash.toLowerCase(),blockHash:receipt.blockHash,blockNumber:receipt.blockNumber,settlementLogIndex:events[0].index,transferLogIndex:transfers[0].index};
}
export async function compiledArtifact(){
 const file=fileURLToPath(new URL('../../../packages/contracts/artifacts/contracts/EnergyTradingDirectSettlementHalfEven.sol/EnergyTradingDirectSettlementHalfEven.json',import.meta.url));
 const data=JSON.parse(await readFile(file,'utf8'));
 if(!/^0x[0-9a-f]+$/i.test(data.bytecode??'')||data.bytecode.length<200||data.contractName!=='EnergyTradingDirectSettlementHalfEven')throw Error('B28 compiled contract artifact missing or invalid');
 return data;
}
