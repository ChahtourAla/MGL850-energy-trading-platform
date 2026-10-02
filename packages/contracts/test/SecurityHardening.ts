import { expect } from 'chai';
import { network } from 'hardhat';

const { ethers } = await network.create();

describe('EnergyTradingEscrow security hardening', function () {
  it('should block a reentrant funding attempt', async function () {
    const [admin, operator, oracle, pauser, buyer, seller] = await ethers.getSigners();

    const token = await ethers.deployContract('ReentrantPaymentToken');

    await token.waitForDeployment();

    const escrow = await ethers.deployContract('EnergyTradingEscrow', [
      await token.getAddress(),
      admin.address,
      operator.address,
      oracle.address,
      pauser.address,
    ]);

    await escrow.waitForDeployment();

    // Allow the malicious token itself
    // to pass the OPERATOR_ROLE check,
    // so the reentrant call reaches
    // ReentrancyGuard.
    await escrow.connect(admin).grantRole(await escrow.OPERATOR_ROLE(), await token.getAddress());

    await escrow
      .connect(operator)
      .createTrade(
        ethers.id('reentrancy-trade'),
        buyer.address,
        seller.address,
        5000n,
        140000n,
        2_000_000_000n,
        2_000_003_600n,
      );

    const requiredAmount = 700000n;

    await token.mint(buyer.address, requiredAmount);

    await token.connect(buyer).approve(await escrow.getAddress(), requiredAmount);

    await token.configureAttack(await escrow.getAddress(), 1n);

    await escrow.connect(operator).fundTrade(1n);

    expect(await token.reentrySucceeded()).to.equal(false);

    const revertData = await token.reentryReturnData();

    const expectedSelector = ethers.id('ReentrancyGuardReentrantCall()').slice(0, 10);

    expect(revertData.slice(0, 10)).to.equal(expectedSelector);

    const trade = await escrow.getTrade(1n);

    expect(trade.status).to.equal(2n);

    expect(await token.balanceOf(await escrow.getAddress())).to.equal(requiredAmount);
  });
});
