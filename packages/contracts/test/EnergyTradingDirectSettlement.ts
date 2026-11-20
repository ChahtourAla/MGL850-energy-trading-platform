import {expect} from 'chai';
import {network} from 'hardhat';
import {buildSettlement,planCommitment} from '../src/b23-identity.js';
import {readFileSync} from 'node:fs';
const {ethers}=await network.create();
const id=(s:string)=>ethers.id(s);

describe('B23 Direct settlement',function(){
 async function fixture(mock=false){
  const [admin,operator,pauser,buyer,seller,other]=await ethers.getSigners();
  const token: any=await ethers.deployContract(mock?'B23MockToken':'TestEnergyUSD',mock?[]:[admin.address]);
  const contract=await ethers.deployContract('EnergyTradingDirectSettlement',[await token.getAddress(),admin.address,operator.address,pauser.address]);
  await token.mint(buyer.address,100000n);await token.connect(buyer).approve(await contract.getAddress(),100000n);
  const chainId=(await ethers.provider.getNetwork()).chainId;
  const build=(changes:Record<string,unknown>={})=>buildSettlement({status:'AUTHORITATIVE',allocationStatus:'VALIDATED',marketId:id('market'),snapshotHash:id('snapshot'),manifestHash:id('manifest'),allocationIds:[id('allocation')],allocationId:id('allocation'),buyer:buyer.address,seller:seller.address,quantityWh:'28',unitPriceMicrousdPerKwh:'90750',algorithmVersion:'1.0.0',pricingPolicyVersion:'SELLER_ASK_V1',token:awaitableToken,chainId,contractAddress:contract.target as string,nonce:1n,deadline:2000000000n,...changes});
  const awaitableToken=await token.getAddress();
  return {admin,operator,pauser,buyer,seller,other,token,contract,build};
 }
 it('transfers exactly and binds identity to EIP-712 with no custody',async()=>{
  const x=await fixture(),v=x.build(),signature=await x.buyer.signTypedData(v.domain,v.types,v.terms);
  expect(await x.contract.settlementId(v.terms)).eq(v.settlementId);
  await expect(x.contract.connect(x.operator).settle(v.terms,signature)).to.emit(x.contract,'EnergyPaymentSettled').and.to.emit(x.token,'Transfer').withArgs(x.buyer.address,x.seller.address,2541n);
  expect(await x.token.balanceOf(x.seller.address)).eq(2541n);expect(await x.token.balanceOf(x.buyer.address)).eq(97459n);expect(await x.token.balanceOf(await x.contract.getAddress())).eq(0n);
  expect(await x.contract.paidAllocations(v.terms.allocationId)).eq(true);expect(await x.contract.executedSettlements(v.settlementId)).eq(true);expect(await x.contract.marketPlans(v.terms.marketId)).eq(v.terms.planCommitment);expect(await x.contract.marketSnapshots(v.terms.marketId)).eq(v.terms.snapshotHash);
  await expect(x.contract.connect(x.operator).settle(v.terms,signature)).to.be.revertedWithCustomError(x.contract,'Replay');
  const revised=x.build({nonce:2n});await expect(x.contract.connect(x.operator).settle(revised.terms,await x.buyer.signTypedData(revised.domain,revised.types,revised.terms))).to.be.revertedWithCustomError(x.contract,'Replay');
 });
 it('rejects nonoperator, invalid signer, changed terms and deployment domains',async()=>{
  const x=await fixture(),v=x.build(),sig=await x.buyer.signTypedData(v.domain,v.types,v.terms);
  await expect(x.contract.connect(x.other).settle(v.terms,sig)).to.be.revert(ethers);
  await expect(x.contract.connect(x.operator).settle(v.terms,await x.operator.signTypedData(v.domain,v.types,v.terms))).to.be.revertedWithCustomError(x.contract,'InvalidSignature');
  await expect(x.contract.connect(x.operator).settle({...v.terms,seller:x.other.address},sig)).to.be.revertedWithCustomError(x.contract,'InvalidSignature');
  const wrong={...v.domain,chainId:v.domain.chainId+1n};await expect(x.contract.connect(x.operator).settle(v.terms,await x.buyer.signTypedData(wrong,v.types,v.terms))).to.be.revertedWithCustomError(x.contract,'InvalidSignature');
  expect(await x.contract.paidAllocations(v.terms.allocationId)).eq(false);
 });
 it('pins plan, rejects nonce reuse and conflicting plan',async()=>{
  const x=await fixture(),v=x.build();await x.contract.connect(x.operator).settle(v.terms,await x.buyer.signTypedData(v.domain,v.types,v.terms));
  const n=x.build({allocationIds:[id('new')],allocationId:id('new'),nonce:1n});await expect(x.contract.connect(x.operator).settle(n.terms,await x.buyer.signTypedData(n.domain,n.types,n.terms))).to.be.revertedWithCustomError(x.contract,'Replay');
  const other=x.build({allocationIds:[id('new')],allocationId:id('new'),nonce:2n});await expect(x.contract.connect(x.operator).settle(other.terms,await x.buyer.signTypedData(other.domain,other.types,other.terms))).to.be.revertedWithCustomError(x.contract,'ConflictingPlan');
  const altered={...v.terms,allocationId:id('third'),snapshotHash:id('different-snapshot'),nonce:3n};await expect(x.contract.connect(x.operator).settle(altered,await x.buyer.signTypedData(v.domain,v.types,altered))).to.be.revertedWithCustomError(x.contract,'ConflictingPlan');
 });
 it('rejects invalid amounts and expired authorizations',async()=>{
  const x=await fixture(),v=x.build(),sig=await x.buyer.signTypedData(v.domain,v.types,v.terms);
  await expect(x.contract.connect(x.operator).settle({...v.terms,amountBaseUnits:2540n},sig)).to.be.revertedWithCustomError(x.contract,'InvalidAmount');
  await expect(x.contract.connect(x.operator).settle({...v.terms,unitPriceMicrousdPerKwh:90751n},sig)).to.be.revertedWithCustomError(x.contract,'InvalidAmount');
  await expect(x.contract.connect(x.operator).settle({...v.terms,deadline:1n},sig)).to.be.revertedWithCustomError(x.contract,'AuthorizationExpired');
 });
 it('pause is restricted and unpause restores settlement',async()=>{
  const x=await fixture(),v=x.build(),sig=await x.buyer.signTypedData(v.domain,v.types,v.terms);
  await expect(x.contract.connect(x.other).pause()).to.be.revert(ethers);await x.contract.connect(x.pauser).pause();await expect(x.contract.connect(x.operator).settle(v.terms,sig)).to.be.revert(ethers);await x.contract.connect(x.pauser).unpause();await x.contract.connect(x.operator).settle(v.terms,sig);
 });
 for(const mode of [1,2,3])it(`rolls back state on failed or non-exact token transfer ${mode}`,async()=>{
  const x=await fixture(true),v=x.build(),sig=await x.buyer.signTypedData(v.domain,v.types,v.terms);await x.token.setMode(mode);
  await expect(x.contract.connect(x.operator).settle(v.terms,sig)).to.be.revert(ethers);expect(await x.contract.paidAllocations(v.terms.allocationId)).eq(false);expect(await x.contract.marketPlans(v.terms.marketId)).eq(ethers.ZeroHash);expect(await x.token.balanceOf(x.seller.address)).eq(0n);
 });
 it('rejects missing allowance and insufficient funds without consuming identities',async()=>{
  const x=await fixture(),v=x.build(),sig=await x.buyer.signTypedData(v.domain,v.types,v.terms);
  await x.token.connect(x.buyer).approve(await x.contract.getAddress(),0);await expect(x.contract.connect(x.operator).settle(v.terms,sig)).to.be.revert(ethers);expect(await x.contract.usedNonces(x.buyer.address,1)).eq(false);
  await x.token.connect(x.buyer).approve(await x.contract.getAddress(),100000);await x.token.connect(x.buyer).transfer(x.other.address,100000);await expect(x.contract.connect(x.operator).settle(v.terms,sig)).to.be.revert(ethers);expect(await x.contract.paidAllocations(v.terms.allocationId)).eq(false);
 });
 it('settles distinct allocations on one committed plan',async()=>{
  const x=await fixture(),ids=[id('allocation'),id('other-allocation')],v=x.build({allocationIds:ids}),w=x.build({allocationIds:ids,allocationId:ids[1],nonce:2n});
  expect(v.terms.planCommitment).eq(w.terms.planCommitment);await x.contract.connect(x.operator).settle(v.terms,await x.buyer.signTypedData(v.domain,v.types,v.terms));await x.contract.connect(x.operator).settle(w.terms,await x.buyer.signTypedData(w.domain,w.types,w.terms));expect(await x.token.balanceOf(x.seller.address)).eq(5082n);
 });
 it('blocks reentry even if token is an operator',async()=>{
  const x=await fixture(true),v=x.build(),sig=await x.buyer.signTypedData(v.domain,v.types,v.terms);
  await x.contract.connect(x.admin).grantRole(await x.contract.OPERATOR_ROLE(),await x.token.getAddress());
  const encoded=x.contract.interface.encodeFunctionData('settle',[v.terms,sig]);await x.token.setCallback(await x.contract.getAddress(),encoded);await x.token.setMode(4);
  await x.contract.connect(x.operator).settle(v.terms,sig);expect(await x.token.callbackSucceeded()).eq(false);expect(await x.token.balanceOf(x.seller.address)).eq(2541n);
 });
 it('rejects wrong contract and token signature domains',async()=>{
  const x=await fixture(),v=x.build(),sig=await x.buyer.signTypedData({...v.domain,verifyingContract:x.other.address},v.types,v.terms);
  await expect(x.contract.connect(x.operator).settle(v.terms,sig)).to.be.revertedWithCustomError(x.contract,'InvalidSignature');
  const wrong={...v.terms,token:x.other.address};await expect(x.contract.connect(x.operator).settle(wrong,sig)).to.be.revertedWithCustomError(x.contract,'InvalidTerms');
 });
 it('rejects invalid constructor configurations',async()=>{
  const [a,b,c]=await ethers.getSigners();await expect(ethers.deployContract('EnergyTradingDirectSettlement',[ethers.ZeroAddress,a.address,b.address,c.address])).to.be.revert(ethers);
  const token=await ethers.deployContract('TestEnergyUSD',[a.address]);await expect(ethers.deployContract('EnergyTradingDirectSettlement',[await token.getAddress(),a.address,a.address,c.address])).to.be.revert(ethers);const bad=await ethers.deployContract('B23WrongDecimals');await expect(ethers.deployContract('EnergyTradingDirectSettlement',[await bad.getAddress(),a.address,b.address,c.address])).to.be.revert(ethers);await expect(ethers.deployContract('EnergyTradingDirectSettlement',[b.address,a.address,b.address,c.address])).to.be.revert(ethers);
 });
 it('rejects every changed signed term without consuming replay state',async()=>{
  const x=await fixture(),v=x.build(),sig=await x.buyer.signTypedData(v.domain,v.types,v.terms);
  const changes=[{marketId:id('changed-market')},{snapshotHash:id('changed-snapshot')},{planCommitment:id('changed-plan')},{allocationId:id('changed-allocation')},{buyer:x.other.address},{seller:x.other.address},{algorithmId:id('algorithm')},{pricingPolicyId:id('policy')},{nonce:9n},{quantityWh:56n,amountBaseUnits:5082n}];
  for(const change of changes)await expect(x.contract.connect(x.operator).settle({...v.terms,...change},sig)).to.be.revertedWithCustomError(x.contract,'InvalidSignature');
  expect(await x.contract.usedNonces(x.buyer.address,1)).eq(false);expect(await x.token.balanceOf(x.seller.address)).eq(0n);
 });
 it('rejects malformed signature, same parties and zero terms',async()=>{
  const x=await fixture(),v=x.build(),sig=await x.buyer.signTypedData(v.domain,v.types,v.terms);
  await expect(x.contract.connect(x.operator).settle(v.terms,'0x12')).to.be.revertedWithCustomError(x.contract,'InvalidSignature');
  await expect(x.contract.connect(x.operator).settle({...v.terms,seller:x.buyer.address},sig)).to.be.revertedWithCustomError(x.contract,'InvalidTerms');
  await expect(x.contract.connect(x.operator).settle({...v.terms,buyer:ethers.ZeroAddress},sig)).to.be.revertedWithCustomError(x.contract,'InvalidTerms');
  await expect(x.contract.connect(x.operator).settle({...v.terms,quantityWh:0},sig)).to.be.revertedWithCustomError(x.contract,'InvalidAmount');
 });
 it('prevents cross-contract replay',async()=>{
  const x=await fixture(),v=x.build(),sig=await x.buyer.signTypedData(v.domain,v.types,v.terms),other=await ethers.deployContract('EnergyTradingDirectSettlement',[await x.token.getAddress(),x.admin.address,x.operator.address,x.pauser.address]);
  await x.token.connect(x.buyer).approve(await other.getAddress(),100000);await expect(other.connect(x.operator).settle(v.terms,sig)).to.be.revertedWithCustomError(other,'InvalidSignature');
 });
 it('reproduces the shared fixed EIP-712 and plan commitment vector',()=>{
  const vector=JSON.parse(readFileSync(new URL('../../shared/fixtures/b23-settlement-vector.json',import.meta.url),'utf8'));
  expect(planCommitment(vector.value.marketId,vector.value.snapshotHash,vector.manifestHash,vector.allocationIds)).eq(vector.value.planCommitment);
  expect(ethers.TypedDataEncoder.hash(vector.domain,vector.types,vector.value)).eq(vector.settlementId);
 });
 it('only admin can grant roles and only pauser can unpause',async()=>{
  const x=await fixture();await expect(x.contract.connect(x.other).grantRole(await x.contract.OPERATOR_ROLE(),x.other.address)).to.be.revert(ethers);
  await x.contract.connect(x.admin).grantRole(await x.contract.OPERATOR_ROLE(),x.other.address);expect(await x.contract.hasRole(await x.contract.OPERATOR_ROLE(),x.other.address)).eq(true);
  await x.contract.connect(x.pauser).pause();await expect(x.contract.connect(x.operator).unpause()).to.be.revert(ethers);await x.contract.connect(x.pauser).unpause();
 });
 it('rejects a signature created for another token and zero price or amount',async()=>{
  const x=await fixture(),v=x.build(),signature=await x.buyer.signTypedData(v.domain,v.types,{...v.terms,token:x.other.address});
  await expect(x.contract.connect(x.operator).settle(v.terms,signature)).to.be.revertedWithCustomError(x.contract,'InvalidSignature');
  const sig=await x.buyer.signTypedData(v.domain,v.types,v.terms);
  await expect(x.contract.connect(x.operator).settle({...v.terms,unitPriceMicrousdPerKwh:0n},sig)).to.be.revertedWithCustomError(x.contract,'InvalidAmount');
  await expect(x.contract.connect(x.operator).settle({...v.terms,amountBaseUnits:0n},sig)).to.be.revertedWithCustomError(x.contract,'InvalidAmount');
 });
 it('requires a validated authoritative allocation in the off-chain builder',async()=>{
  const x=await fixture();expect(()=>x.build({status:'DRAFT'})).to.throw('authoritative allocation required');expect(()=>x.build({allocationStatus:'PLANNED'})).to.throw('authoritative allocation required');
  expect(()=>x.build({quantityWh:'1',unitPriceMicrousdPerKwh:'1'})).to.throw('invalid exact payment');
 });
});
