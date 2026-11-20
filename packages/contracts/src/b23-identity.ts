import { AbiCoder, TypedDataEncoder, ZeroAddress, getAddress, isHexString, keccak256, toUtf8Bytes } from 'ethers';

export const settlementTypes = { Settlement: [
  {name:'token',type:'address'}, {name:'marketId',type:'bytes32'}, {name:'snapshotHash',type:'bytes32'},
  {name:'planCommitment',type:'bytes32'}, {name:'allocationId',type:'bytes32'}, {name:'buyer',type:'address'},
  {name:'seller',type:'address'}, {name:'quantityWh',type:'uint256'}, {name:'unitPriceMicrousdPerKwh',type:'uint256'},
  {name:'amountBaseUnits',type:'uint256'}, {name:'algorithmId',type:'bytes32'}, {name:'pricingPolicyId',type:'bytes32'},
  {name:'nonce',type:'uint256'}, {name:'deadline',type:'uint256'},
] };
export const versionId = (s: string) => { if(!/^[A-Za-z0-9._-]{1,128}$/.test(s)) throw Error('invalid policy version'); return keccak256(toUtf8Bytes(s)); };
export const settlementDomain = (chainId: bigint, verifyingContract: string) => {
  if(chainId<=0n || getAddress(verifyingContract)===ZeroAddress) throw Error('invalid deployment domain');
  return {name:'MGL850 Energy Settlement',version:'1',chainId,verifyingContract:getAddress(verifyingContract)};
};
export function planCommitment(marketId:string,snapshotHash:string,manifestHash:string,allocationIds:string[]) {
  const ids=allocationIds.map(x=>x.toLowerCase()).sort();
  if(![marketId,snapshotHash,manifestHash,...ids].every(x=>isHexString(x,32) && !/^0x0{64}$/i.test(x)) || new Set(ids).size!==ids.length) throw Error('invalid plan commitment fields');
  return keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32','bytes32','bytes32','bytes32','bytes32[]'],[keccak256(toUtf8Bytes('mgl850:b23:plan:1')),marketId,snapshotHash,manifestHash,ids]));
}
export function buildSettlement(input: {status:string; allocationStatus:string; marketId:string;snapshotHash:string;manifestHash:string;allocationIds:string[];allocationId:string;buyer:string;seller:string;quantityWh:string;unitPriceMicrousdPerKwh:string;algorithmVersion:string;pricingPolicyVersion:string;token:string;chainId:bigint;contractAddress:string;nonce:bigint;deadline:bigint}) {
  if(input.status!=='AUTHORITATIVE' || input.allocationStatus!=='VALIDATED' || !input.allocationIds.includes(input.allocationId)) throw Error('authoritative allocation required');
  if(!/^[1-9][0-9]*$/.test(input.quantityWh)||!/^[1-9][0-9]*$/.test(input.unitPriceMicrousdPerKwh)) throw Error('invalid integer');
  const q=BigInt(input.quantityWh), p=BigInt(input.unitPriceMicrousdPerKwh), max=9223372036854775807n, n=q*p;
  if(q>max||p>max||n%1000n||n/1000n===0n||n/1000n>max||input.nonce<0n||input.deadline<0n)throw Error('invalid exact payment');
  const buyer=getAddress(input.buyer),seller=getAddress(input.seller),token=getAddress(input.token);
  if(buyer===ZeroAddress||seller===ZeroAddress||buyer===seller||token===ZeroAddress) throw Error('invalid addresses');
  const domain=settlementDomain(input.chainId,input.contractAddress);
  const terms={token,marketId:input.marketId,snapshotHash:input.snapshotHash,planCommitment:planCommitment(input.marketId,input.snapshotHash,input.manifestHash,input.allocationIds),allocationId:input.allocationId,buyer,seller,quantityWh:q,unitPriceMicrousdPerKwh:p,amountBaseUnits:n/1000n,algorithmId:versionId(input.algorithmVersion),pricingPolicyId:versionId(input.pricingPolicyVersion),nonce:input.nonce,deadline:input.deadline};
  return {domain,types:settlementTypes,terms,settlementId:TypedDataEncoder.hash(domain,settlementTypes,terms)};
}
