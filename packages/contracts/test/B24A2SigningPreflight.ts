import {expect} from 'chai';
import {network} from 'hardhat';
import {buildSettlement} from '../src/b23-identity.js';
const {ethers}=await network.create();
describe('B24-A2 unsigned preflight digest',function(){
 it('matches the captured disposable PostgreSQL reservation digest on Solidity when provided',async function(){
  if(!process.env.B24_A2_RESERVATION){this.skip();return;}
  const saved=JSON.parse(process.env.B24_A2_RESERVATION);
  const [admin,operator,pauser]=await ethers.getSigners();
  const token=await ethers.deployContract('TestEnergyUSD',[admin.address]);
  const contract=await ethers.deployContract('EnergyTradingDirectSettlement',[await token.getAddress(),admin.address,operator.address,pauser.address]);
  expect((await ethers.provider.getNetwork()).chainId).eq(BigInt(saved.domain.chainId));
  await ethers.provider.send('hardhat_setCode',[saved.domain.verifyingContract,await ethers.provider.getCode(await contract.getAddress())]);
  const instance=contract.attach(saved.domain.verifyingContract);
  expect(await instance.settlementId(saved.terms)).eq(saved.settlementId);
  expect(ethers.TypedDataEncoder.hash(saved.domain,saved.types,saved.terms)).eq(saved.settlementId);
 });
 it('agrees with Solidity for exact 2541-unit terms and binds deployment and economics',async()=>{
  const [admin,operator,pauser,buyer,seller]=await ethers.getSigners();
  const token=await ethers.deployContract('TestEnergyUSD',[admin.address]);
  const contract=await ethers.deployContract('EnergyTradingDirectSettlement',[await token.getAddress(),admin.address,operator.address,pauser.address]);
  const marketId=ethers.id('b24a2-market'),snapshotHash=ethers.id('b24a2-snapshot'),manifestHash=ethers.id('b24a2-manifest'),allocationId=ethers.id('b24a2-allocation');
  const input={status:'AUTHORITATIVE',allocationStatus:'VALIDATED',marketId,snapshotHash,manifestHash,allocationIds:[allocationId],allocationId,buyer:buyer.address,seller:seller.address,quantityWh:'28',unitPriceMicrousdPerKwh:'90750',algorithmVersion:'1.0.0',pricingPolicyVersion:'SELLER_ASK_V1',token:await token.getAddress(),chainId:(await ethers.provider.getNetwork()).chainId,contractAddress:await contract.getAddress(),nonce:0n,deadline:2000000000n};
  const built=buildSettlement(input);expect(built.terms.amountBaseUnits).eq(2541n);expect(await contract.settlementId(built.terms)).eq(built.settlementId);expect(ethers.TypedDataEncoder.hash(built.domain,built.types,built.terms)).eq(built.settlementId);
  expect(buildSettlement({...input,nonce:1n}).settlementId).not.eq(built.settlementId);
  expect(buildSettlement({...input,chainId:input.chainId+1n}).settlementId).not.eq(built.settlementId);
  expect(buildSettlement({...input,contractAddress:operator.address}).settlementId).not.eq(built.settlementId);
  expect(buildSettlement({...input,unitPriceMicrousdPerKwh:'91000'}).settlementId).not.eq(built.settlementId);
 });
});
