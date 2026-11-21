import {expect} from 'chai';
import {network} from 'hardhat';
import {buildSettlement} from '../src/b23-identity.js';
const {ethers}=await network.create();

describe('B24 local token and settlement integration (synthetic)',function(){
 it('funds and approves exactly 2541 units and settles once with an ephemeral buyer',async()=>{
  const [admin,operator,pauser,seller]=await ethers.getSigners();
  const buyer=ethers.Wallet.createRandom().connect(ethers.provider);
  await (await admin.sendTransaction({to:buyer.address,value:ethers.parseEther('1')})).wait();
  const token:any=await ethers.deployContract('TestEnergyUSD',[admin.address]);
  const settlement:any=await ethers.deployContract('EnergyTradingDirectSettlement',[await token.getAddress(),admin.address,operator.address,pauser.address]);
  const settlementAddress=await settlement.getAddress(),tokenAddress=await token.getAddress();
  const marketId=ethers.id('b24-local-market'),snapshotHash=ethers.id('b24-local-snapshot'),manifestHash=ethers.id('b24-local-manifest'),allocationId=ethers.id('b24-local-allocation');
  const data=buildSettlement({status:'AUTHORITATIVE',allocationStatus:'VALIDATED',marketId,snapshotHash,manifestHash,allocationIds:[allocationId],allocationId,buyer:buyer.address,seller:seller.address,quantityWh:'28',unitPriceMicrousdPerKwh:'90750',algorithmVersion:'1.0.0',pricingPolicyVersion:'SELLER_ASK_V1',token:tokenAddress,chainId:(await ethers.provider.getNetwork()).chainId,contractAddress:settlementAddress,nonce:0n,deadline:2000000000n});
  expect(data.terms.amountBaseUnits).eq(2541n);
  const signature=await buyer.signTypedData(data.domain,data.types,data.terms);
  expect(ethers.verifyTypedData(data.domain,data.types,data.terms,signature)).eq(buyer.address);
  expect(await settlement.settlementId(data.terms)).eq(data.settlementId);
  await expect(token.connect(operator).mint(buyer.address,2541n)).to.be.revert(ethers);
  await expect(settlement.connect(operator).settle(data.terms,signature)).to.be.revert(ethers);
  expect(await settlement.paidAllocations(allocationId)).eq(false);
  const mint=await (await token.mint(buyer.address,2541n)).wait();expect(mint.status).eq(1);
  expect(await token.balanceOf(buyer.address)).eq(2541n);
  const approval=await (await token.connect(buyer).approve(settlementAddress,2541n)).wait();expect(approval.status).eq(1);
  expect(await token.allowance(buyer.address,settlementAddress)).eq(2541n);
  await expect(settlement.connect(operator).settle(data.terms,signature)).to.emit(settlement,'EnergyPaymentSettled');
  expect(await token.balanceOf(buyer.address)).eq(0n);expect(await token.balanceOf(seller.address)).eq(2541n);expect(await token.balanceOf(settlementAddress)).eq(0n);
  expect(await token.allowance(buyer.address,settlementAddress)).eq(0n);
  await expect(settlement.connect(operator).settle(data.terms,signature)).to.be.revertedWithCustomError(settlement,'Replay');
 });
});
