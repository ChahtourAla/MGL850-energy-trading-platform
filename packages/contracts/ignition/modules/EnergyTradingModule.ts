import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';

const EnergyTradingModule = buildModule('EnergyTradingModule', (m) => {
  // Local Hardhat accounts used to model
  // the application's separated responsibilities.
  const admin = m.getAccount(0);
  const operator = m.getAccount(1);
  const oracle = m.getAccount(2);
  const pauser = m.getAccount(3);

  // Deploy the six-decimal prototype payment token.
  // The admin receives DEFAULT_ADMIN_ROLE and MINTER_ROLE.
  const testEnergyUSD = m.contract('TestEnergyUSD', [admin]);

  // Deploy the main energy-trading escrow.
  const energyTradingEscrow = m.contract('EnergyTradingEscrow', [
    testEnergyUSD,
    admin,
    operator,
    oracle,
    pauser,
  ]);

  return {
    testEnergyUSD,
    energyTradingEscrow,
  };
});

export default EnergyTradingModule;
