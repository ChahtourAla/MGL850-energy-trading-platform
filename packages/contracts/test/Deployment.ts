import { expect } from 'chai';
import { network } from 'hardhat';

import EnergyTradingModule from '../ignition/modules/EnergyTradingModule.js';

const { ethers, ignition } = await network.create();

describe('EnergyTradingModule local deployment', function () {
  it('should deploy and correctly configure both contracts', async function () {
    const [admin, operator, oracle, pauser] = await ethers.getSigners();

    const { testEnergyUSD, energyTradingEscrow } = await ignition.deploy(EnergyTradingModule);

    const tokenAddress = await testEnergyUSD.getAddress();

    const escrowAddress = await energyTradingEscrow.getAddress();

    // -------------------------------------------------------------
    // Contracts really exist
    // -------------------------------------------------------------

    expect(await ethers.provider.getCode(tokenAddress)).to.not.equal('0x');

    expect(await ethers.provider.getCode(escrowAddress)).to.not.equal('0x');

    // -------------------------------------------------------------
    // Escrow points to the correct payment token
    // -------------------------------------------------------------

    expect(await energyTradingEscrow.paymentToken()).to.equal(tokenAddress);

    // -------------------------------------------------------------
    // TestEnergyUSD configuration
    // -------------------------------------------------------------

    expect(await testEnergyUSD.decimals()).to.equal(6n);

    expect(
      await testEnergyUSD.hasRole(await testEnergyUSD.DEFAULT_ADMIN_ROLE(), admin.address),
    ).to.equal(true);

    expect(await testEnergyUSD.hasRole(await testEnergyUSD.MINTER_ROLE(), admin.address)).to.equal(
      true,
    );

    // -------------------------------------------------------------
    // EnergyTradingEscrow role configuration
    // -------------------------------------------------------------

    expect(
      await energyTradingEscrow.hasRole(
        await energyTradingEscrow.DEFAULT_ADMIN_ROLE(),
        admin.address,
      ),
    ).to.equal(true);

    expect(
      await energyTradingEscrow.hasRole(
        await energyTradingEscrow.OPERATOR_ROLE(),
        operator.address,
      ),
    ).to.equal(true);

    expect(
      await energyTradingEscrow.hasRole(await energyTradingEscrow.ORACLE_ROLE(), oracle.address),
    ).to.equal(true);

    expect(
      await energyTradingEscrow.hasRole(await energyTradingEscrow.PAUSER_ROLE(), pauser.address),
    ).to.equal(true);

    // -------------------------------------------------------------
    // Initial trade state
    // -------------------------------------------------------------

    expect(await energyTradingEscrow.nextTradeId()).to.equal(1n);
  });
});
