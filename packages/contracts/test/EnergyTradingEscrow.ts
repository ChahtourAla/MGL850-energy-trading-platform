import { expect } from 'chai';
import { network } from 'hardhat';

const { ethers, networkHelpers } = await network.create();

describe('EnergyTradingEscrow', function () {
  async function deployContracts() {
    const [admin, operator, oracle, pauser, buyer, seller] = await ethers.getSigners();

    const token = await ethers.deployContract('TestEnergyUSD', [admin.address]);

    await token.waitForDeployment();

    const escrow = await ethers.deployContract('EnergyTradingEscrow', [
      await token.getAddress(),
      admin.address,
      operator.address,
      oracle.address,
      pauser.address,
    ]);

    await escrow.waitForDeployment();

    return {
      token,
      escrow,
      admin,
      operator,
      oracle,
      pauser,
      buyer,
      seller,
    };
  }

  async function createDefaultTrade() {
    const deployment = await deployContracts();

    const { escrow, operator, buyer, seller } = deployment;

    const externalTradeId = ethers.id('trade-funding-001');

    await escrow
      .connect(operator)
      .createTrade(
        externalTradeId,
        buyer.address,
        seller.address,
        5000n,
        140000n,
        2_000_000_000n,
        2_000_003_600n,
      );

    return {
      ...deployment,
      externalTradeId,
      onChainTradeId: 1n,
      requiredAmount: 700000n,
    };
  }

  async function createFundedTrade() {
    const deployment = await createDefaultTrade();

    const { token, escrow, admin, operator, buyer, onChainTradeId, requiredAmount } = deployment;

    await token.connect(admin).mint(buyer.address, requiredAmount);

    await token.connect(buyer).approve(await escrow.getAddress(), requiredAmount);

    await escrow.connect(operator).fundTrade(onChainTradeId);

    return deployment;
  }

  async function createFundedTradeWithDynamicWindow() {
    const deployment = await deployContracts();

    const { token, escrow, admin, operator, buyer, seller } = deployment;

    const now = await networkHelpers.time.latest();

    const deliveryStart = BigInt(now + 60);

    const deliveryDeadline = BigInt(now + 3600);

    const externalTradeId = ethers.id(`expiring-trade-${now}`);

    await escrow
      .connect(operator)
      .createTrade(
        externalTradeId,
        buyer.address,
        seller.address,
        5000n,
        140000n,
        deliveryStart,
        deliveryDeadline,
      );

    const requiredAmount = 700000n;

    await token.connect(admin).mint(buyer.address, requiredAmount);

    await token.connect(buyer).approve(await escrow.getAddress(), requiredAmount);

    await escrow.connect(operator).fundTrade(1n);

    return {
      ...deployment,
      onChainTradeId: 1n,
      requiredAmount,
      deliveryStart,
      deliveryDeadline,
    };
  }

  it('should deploy with the correct payment token', async function () {
    const { token, escrow } = await deployContracts();

    expect(await escrow.paymentToken()).to.equal(await token.getAddress());
  });

  it('should start trade IDs from 1', async function () {
    const { escrow } = await deployContracts();

    expect(await escrow.nextTradeId()).to.equal(1n);
  });

  it('should assign all initial roles', async function () {
    const { escrow, admin, operator, oracle, pauser } = await deployContracts();

    expect(await escrow.hasRole(await escrow.DEFAULT_ADMIN_ROLE(), admin.address)).to.equal(true);

    expect(await escrow.hasRole(await escrow.OPERATOR_ROLE(), operator.address)).to.equal(true);

    expect(await escrow.hasRole(await escrow.ORACLE_ROLE(), oracle.address)).to.equal(true);

    expect(await escrow.hasRole(await escrow.PAUSER_ROLE(), pauser.address)).to.equal(true);
  });

  it('should allow the pauser to pause and unpause', async function () {
    const { escrow, pauser } = await deployContracts();

    await escrow.connect(pauser).pause();

    expect(await escrow.paused()).to.equal(true);

    await escrow.connect(pauser).unpause();

    expect(await escrow.paused()).to.equal(false);
  });

  it('should reject an unknown trade', async function () {
    const { escrow } = await deployContracts();

    await expect(escrow.getTrade(1n))
      .to.be.revertedWithCustomError(escrow, 'TradeNotFound')
      .withArgs(1n);
  });

  it('should create a valid energy trade', async function () {
    const { escrow, operator, buyer, seller } = await deployContracts();

    const externalTradeId = ethers.id('trade-001');

    const quantityWh = 5000n;

    const unitPrice = 140000n;

    const deliveryStart = 2_000_000_000n;

    const deliveryDeadline = 2_000_003_600n;

    await escrow
      .connect(operator)
      .createTrade(
        externalTradeId,
        buyer.address,
        seller.address,
        quantityWh,
        unitPrice,
        deliveryStart,
        deliveryDeadline,
      );

    const trade = await escrow.getTrade(1n);

    expect(trade.externalTradeId).to.equal(externalTradeId);

    expect(trade.buyer).to.equal(buyer.address);

    expect(trade.seller).to.equal(seller.address);

    expect(trade.quantityWh).to.equal(5000n);

    expect(trade.unitPriceMicrousdPerKwh).to.equal(140000n);

    expect(trade.totalAmountMicrousd).to.equal(700000n);

    expect(trade.deliveryStart).to.equal(deliveryStart);

    expect(trade.deliveryDeadline).to.equal(deliveryDeadline);

    expect(trade.deliveredWh).to.equal(0n);

    expect(trade.evidenceHash).to.equal(ethers.ZeroHash);

    // CREATED is index 0 in the enum.
    expect(trade.status).to.equal(0n);
  });

  it('should emit TradeCreated', async function () {
    const { escrow, operator, buyer, seller } = await deployContracts();

    const externalTradeId = ethers.id('trade-event-001');

    await expect(
      escrow
        .connect(operator)
        .createTrade(
          externalTradeId,
          buyer.address,
          seller.address,
          5000n,
          140000n,
          2_000_000_000n,
          2_000_003_600n,
        ),
    )
      .to.emit(escrow, 'TradeCreated')
      .withArgs(1n, externalTradeId, buyer.address, seller.address, 5000n, 140000n);
  });

  it('should map the external trade ID to the on-chain trade ID', async function () {
    const { escrow, operator, buyer, seller } = await deployContracts();

    const externalTradeId = ethers.id('trade-mapping-001');

    await escrow
      .connect(operator)
      .createTrade(
        externalTradeId,
        buyer.address,
        seller.address,
        5000n,
        140000n,
        2_000_000_000n,
        2_000_003_600n,
      );

    expect(await escrow.getOnChainTradeId(externalTradeId)).to.equal(1n);
  });

  it('should increment on-chain trade IDs', async function () {
    const { escrow, operator, buyer, seller } = await deployContracts();

    await escrow
      .connect(operator)
      .createTrade(
        ethers.id('trade-001'),
        buyer.address,
        seller.address,
        5000n,
        140000n,
        2_000_000_000n,
        2_000_003_600n,
      );

    await escrow
      .connect(operator)
      .createTrade(
        ethers.id('trade-002'),
        buyer.address,
        seller.address,
        3000n,
        150000n,
        2_000_000_000n,
        2_000_003_600n,
      );

    expect(await escrow.nextTradeId()).to.equal(3n);

    expect(await escrow.getOnChainTradeId(ethers.id('trade-001'))).to.equal(1n);

    expect(await escrow.getOnChainTradeId(ethers.id('trade-002'))).to.equal(2n);
  });

  it('should reject duplicate external trade IDs', async function () {
    const { escrow, operator, buyer, seller } = await deployContracts();

    const externalTradeId = ethers.id('duplicate-trade');

    await escrow
      .connect(operator)
      .createTrade(
        externalTradeId,
        buyer.address,
        seller.address,
        5000n,
        140000n,
        2_000_000_000n,
        2_000_003_600n,
      );

    await expect(
      escrow
        .connect(operator)
        .createTrade(
          externalTradeId,
          buyer.address,
          seller.address,
          5000n,
          140000n,
          2_000_000_000n,
          2_000_003_600n,
        ),
    )
      .to.be.revertedWithCustomError(escrow, 'ExternalTradeIdAlreadyUsed')
      .withArgs(externalTradeId);
  });

  it('should reject createTrade from a non-operator', async function () {
    const { escrow, buyer, seller } = await deployContracts();

    const operatorRole = await escrow.OPERATOR_ROLE();

    await expect(
      escrow
        .connect(buyer)
        .createTrade(
          ethers.id('unauthorized-trade'),
          buyer.address,
          seller.address,
          5000n,
          140000n,
          2_000_000_000n,
          2_000_003_600n,
        ),
    )
      .to.be.revertedWithCustomError(escrow, 'AccessControlUnauthorizedAccount')
      .withArgs(buyer.address, operatorRole);
  });

  it('should reject the same address as buyer and seller', async function () {
    const { escrow, operator, buyer } = await deployContracts();

    await expect(
      escrow
        .connect(operator)
        .createTrade(
          ethers.id('same-party'),
          buyer.address,
          buyer.address,
          5000n,
          140000n,
          2_000_000_000n,
          2_000_003_600n,
        ),
    ).to.be.revertedWithCustomError(escrow, 'InvalidTradeParties');
  });

  it('should reject zero energy quantity', async function () {
    const { escrow, operator, buyer, seller } = await deployContracts();

    await expect(
      escrow
        .connect(operator)
        .createTrade(
          ethers.id('zero-quantity'),
          buyer.address,
          seller.address,
          0n,
          140000n,
          2_000_000_000n,
          2_000_003_600n,
        ),
    ).to.be.revertedWithCustomError(escrow, 'InvalidQuantity');
  });

  it('should reject zero unit price', async function () {
    const { escrow, operator, buyer, seller } = await deployContracts();

    await expect(
      escrow
        .connect(operator)
        .createTrade(
          ethers.id('zero-price'),
          buyer.address,
          seller.address,
          5000n,
          0n,
          2_000_000_000n,
          2_000_003_600n,
        ),
    ).to.be.revertedWithCustomError(escrow, 'InvalidUnitPrice');
  });

  it('should reject an invalid delivery window', async function () {
    const { escrow, operator, buyer, seller } = await deployContracts();

    await expect(
      escrow
        .connect(operator)
        .createTrade(
          ethers.id('invalid-window'),
          buyer.address,
          seller.address,
          5000n,
          140000n,
          2_000_003_600n,
          2_000_000_000n,
        ),
    ).to.be.revertedWithCustomError(escrow, 'InvalidDeliveryWindow');
  });

  it('should not create trades while paused', async function () {
    const { escrow, operator, pauser, buyer, seller } = await deployContracts();

    await escrow.connect(pauser).pause();

    await expect(
      escrow
        .connect(operator)
        .createTrade(
          ethers.id('paused-trade'),
          buyer.address,
          seller.address,
          5000n,
          140000n,
          2_000_000_000n,
          2_000_003_600n,
        ),
    ).to.be.revertedWithCustomError(escrow, 'EnforcedPause');
  });

  it('should fund a created trade', async function () {
    const { token, escrow, admin, operator, buyer, onChainTradeId, requiredAmount } =
      await createDefaultTrade();

    await token.connect(admin).mint(buyer.address, requiredAmount);

    await token.connect(buyer).approve(await escrow.getAddress(), requiredAmount);

    await escrow.connect(operator).fundTrade(onChainTradeId);

    const trade = await escrow.getTrade(onChainTradeId);

    // AWAITING_DELIVERY = enum index 2
    expect(trade.status).to.equal(2n);
  });

  it('should transfer the buyer payment into escrow', async function () {
    const { token, escrow, admin, operator, buyer, onChainTradeId, requiredAmount } =
      await createDefaultTrade();

    await token.connect(admin).mint(buyer.address, requiredAmount);

    await token.connect(buyer).approve(await escrow.getAddress(), requiredAmount);

    await escrow.connect(operator).fundTrade(onChainTradeId);

    expect(await token.balanceOf(buyer.address)).to.equal(0n);

    expect(await token.balanceOf(await escrow.getAddress())).to.equal(requiredAmount);
  });

  it('should emit TradeFunded', async function () {
    const { token, escrow, admin, operator, buyer, onChainTradeId, requiredAmount } =
      await createDefaultTrade();

    await token.connect(admin).mint(buyer.address, requiredAmount);

    await token.connect(buyer).approve(await escrow.getAddress(), requiredAmount);

    await expect(escrow.connect(operator).fundTrade(onChainTradeId))
      .to.emit(escrow, 'TradeFunded')
      .withArgs(onChainTradeId, requiredAmount);
  });

  it('should reject funding when the buyer has insufficient balance', async function () {
    const { token, escrow, admin, operator, buyer, onChainTradeId, requiredAmount } =
      await createDefaultTrade();

    const smallerAmount = requiredAmount - 1n;

    await token.connect(admin).mint(buyer.address, smallerAmount);

    await token.connect(buyer).approve(await escrow.getAddress(), requiredAmount);

    await expect(escrow.connect(operator).fundTrade(onChainTradeId))
      .to.be.revertedWithCustomError(escrow, 'InsufficientBuyerBalance')
      .withArgs(smallerAmount, requiredAmount);
  });

  it('should reject funding when allowance is insufficient', async function () {
    const { token, escrow, admin, operator, buyer, onChainTradeId, requiredAmount } =
      await createDefaultTrade();

    await token.connect(admin).mint(buyer.address, requiredAmount);

    const smallerAllowance = requiredAmount - 1n;

    await token.connect(buyer).approve(await escrow.getAddress(), smallerAllowance);

    await expect(escrow.connect(operator).fundTrade(onChainTradeId))
      .to.be.revertedWithCustomError(escrow, 'InsufficientBuyerAllowance')
      .withArgs(smallerAllowance, requiredAmount);
  });

  it('should reject funding the same trade twice', async function () {
    const { token, escrow, admin, operator, buyer, onChainTradeId, requiredAmount } =
      await createDefaultTrade();

    await token.connect(admin).mint(buyer.address, requiredAmount * 2n);

    await token.connect(buyer).approve(await escrow.getAddress(), requiredAmount * 2n);

    await escrow.connect(operator).fundTrade(onChainTradeId);

    await expect(escrow.connect(operator).fundTrade(onChainTradeId))
      .to.be.revertedWithCustomError(escrow, 'InvalidTradeStatus')
      .withArgs(onChainTradeId, 2n, 0n);
  });

  it('should reject funding a nonexistent trade', async function () {
    const { escrow, operator } = await deployContracts();

    await expect(escrow.connect(operator).fundTrade(999n))
      .to.be.revertedWithCustomError(escrow, 'TradeNotFound')
      .withArgs(999n);
  });

  it('should reject fundTrade from a non-operator', async function () {
    const { escrow, buyer, onChainTradeId } = await createDefaultTrade();

    const operatorRole = await escrow.OPERATOR_ROLE();

    await expect(escrow.connect(buyer).fundTrade(onChainTradeId))
      .to.be.revertedWithCustomError(escrow, 'AccessControlUnauthorizedAccount')
      .withArgs(buyer.address, operatorRole);
  });

  it('should reject funding while paused', async function () {
    const { token, escrow, admin, operator, pauser, buyer, onChainTradeId, requiredAmount } =
      await createDefaultTrade();

    await token.connect(admin).mint(buyer.address, requiredAmount);

    await token.connect(buyer).approve(await escrow.getAddress(), requiredAmount);

    await escrow.connect(pauser).pause();

    await expect(escrow.connect(operator).fundTrade(onChainTradeId)).to.be.revertedWithCustomError(
      escrow,
      'EnforcedPause',
    );
  });

  it('should confirm a successful energy delivery', async function () {
    const { escrow, oracle, onChainTradeId } = await createFundedTrade();

    const evidenceHash = ethers.id('delivery-evidence-001');

    await escrow.connect(oracle).confirmDelivery(onChainTradeId, 5000n, evidenceHash);

    const trade = await escrow.getTrade(onChainTradeId);

    expect(trade.deliveredWh).to.equal(5000n);

    expect(trade.evidenceHash).to.equal(evidenceHash);

    // COMPLETED = enum index 4
    expect(trade.status).to.equal(4n);
  });

  it('should release escrowed payment to the seller', async function () {
    const { token, escrow, oracle, seller, onChainTradeId, requiredAmount } =
      await createFundedTrade();

    expect(await token.balanceOf(seller.address)).to.equal(0n);

    expect(await token.balanceOf(await escrow.getAddress())).to.equal(requiredAmount);

    await escrow
      .connect(oracle)
      .confirmDelivery(onChainTradeId, 5000n, ethers.id('delivery-payment-evidence'));

    expect(await token.balanceOf(seller.address)).to.equal(requiredAmount);

    expect(await token.balanceOf(await escrow.getAddress())).to.equal(0n);
  });

  it('should emit DeliveryConfirmed', async function () {
    const { escrow, oracle, onChainTradeId } = await createFundedTrade();

    const evidenceHash = ethers.id('delivery-event-evidence');

    await expect(escrow.connect(oracle).confirmDelivery(onChainTradeId, 5000n, evidenceHash))
      .to.emit(escrow, 'DeliveryConfirmed')
      .withArgs(onChainTradeId, 5000n, evidenceHash);
  });

  it('should emit TradeSettled', async function () {
    const { escrow, oracle, seller, onChainTradeId, requiredAmount } = await createFundedTrade();

    await expect(
      escrow
        .connect(oracle)
        .confirmDelivery(onChainTradeId, 5000n, ethers.id('settlement-evidence')),
    )
      .to.emit(escrow, 'TradeSettled')
      .withArgs(onChainTradeId, seller.address, requiredAmount);
  });

  it('should accept delivery greater than the required quantity', async function () {
    const { escrow, oracle, onChainTradeId } = await createFundedTrade();

    await escrow.connect(oracle).confirmDelivery(onChainTradeId, 5200n, ethers.id('over-delivery'));

    const trade = await escrow.getTrade(onChainTradeId);

    expect(trade.deliveredWh).to.equal(5200n);

    expect(trade.status).to.equal(4n);
  });

  it('should reject incomplete energy delivery', async function () {
    const { escrow, oracle, onChainTradeId } = await createFundedTrade();

    await expect(
      escrow
        .connect(oracle)
        .confirmDelivery(onChainTradeId, 4999n, ethers.id('incomplete-delivery')),
    )
      .to.be.revertedWithCustomError(escrow, 'InsufficientDelivery')
      .withArgs(5000n, 4999n);
  });

  it('should preserve escrow and state after incomplete delivery', async function () {
    const { token, escrow, oracle, seller, onChainTradeId, requiredAmount } =
      await createFundedTrade();

    await expect(
      escrow.connect(oracle).confirmDelivery(onChainTradeId, 4000n, ethers.id('failed-delivery')),
    ).to.be.revertedWithCustomError(escrow, 'InsufficientDelivery');

    const trade = await escrow.getTrade(onChainTradeId);

    expect(trade.status).to.equal(2n);

    expect(trade.deliveredWh).to.equal(0n);

    expect(await token.balanceOf(seller.address)).to.equal(0n);

    expect(await token.balanceOf(await escrow.getAddress())).to.equal(requiredAmount);
  });

  it('should reject delivery confirmation from a non-oracle', async function () {
    const { escrow, operator, onChainTradeId } = await createFundedTrade();

    const oracleRole = await escrow.ORACLE_ROLE();

    await expect(
      escrow
        .connect(operator)
        .confirmDelivery(onChainTradeId, 5000n, ethers.id('unauthorized-delivery')),
    )
      .to.be.revertedWithCustomError(escrow, 'AccessControlUnauthorizedAccount')
      .withArgs(operator.address, oracleRole);
  });

  it('should reject delivery confirmation before funding', async function () {
    const { escrow, oracle, onChainTradeId } = await createDefaultTrade();

    await expect(
      escrow.connect(oracle).confirmDelivery(onChainTradeId, 5000n, ethers.id('unfunded-delivery')),
    )
      .to.be.revertedWithCustomError(escrow, 'InvalidTradeStatus')
      .withArgs(onChainTradeId, 0n, 2n);
  });

  it('should reject delivery confirmation for a nonexistent trade', async function () {
    const { escrow, oracle } = await deployContracts();

    await expect(escrow.connect(oracle).confirmDelivery(999n, 5000n, ethers.id('unknown-trade')))
      .to.be.revertedWithCustomError(escrow, 'TradeNotFound')
      .withArgs(999n);
  });

  it('should reject delivery confirmation twice', async function () {
    const { escrow, oracle, onChainTradeId } = await createFundedTrade();

    await escrow
      .connect(oracle)
      .confirmDelivery(onChainTradeId, 5000n, ethers.id('first-confirmation'));

    await expect(
      escrow
        .connect(oracle)
        .confirmDelivery(onChainTradeId, 5000n, ethers.id('second-confirmation')),
    )
      .to.be.revertedWithCustomError(escrow, 'InvalidTradeStatus')
      .withArgs(onChainTradeId, 4n, 2n);
  });

  it('should reject delivery confirmation while paused', async function () {
    const { escrow, oracle, pauser, onChainTradeId } = await createFundedTrade();

    await escrow.connect(pauser).pause();

    await expect(
      escrow.connect(oracle).confirmDelivery(onChainTradeId, 5000n, ethers.id('paused-delivery')),
    ).to.be.revertedWithCustomError(escrow, 'EnforcedPause');
  });

  it('should cancel a created trade', async function () {
    const { escrow, operator, onChainTradeId } = await createDefaultTrade();

    await escrow.connect(operator).cancelTrade(onChainTradeId);

    const trade = await escrow.getTrade(onChainTradeId);

    // CANCELLED = 5
    expect(trade.status).to.equal(5n);
  });

  it('should emit TradeCancelled', async function () {
    const { escrow, operator, onChainTradeId } = await createDefaultTrade();

    await expect(escrow.connect(operator).cancelTrade(onChainTradeId))
      .to.emit(escrow, 'TradeCancelled')
      .withArgs(onChainTradeId);
  });

  it('should reject cancellation after funding', async function () {
    const { escrow, operator, onChainTradeId } = await createFundedTrade();

    await expect(escrow.connect(operator).cancelTrade(onChainTradeId))
      .to.be.revertedWithCustomError(escrow, 'InvalidTradeStatus')
      .withArgs(onChainTradeId, 2n, 0n);
  });

  it('should reject expiration before the delivery deadline', async function () {
    const { escrow, operator, onChainTradeId } = await createFundedTradeWithDynamicWindow();

    await expect(
      escrow.connect(operator).expireTrade(onChainTradeId),
    ).to.be.revertedWithCustomError(escrow, 'DeliveryDeadlineNotReached');
  });

  it('should expire a funded trade after the deadline', async function () {
    const { escrow, operator, onChainTradeId, deliveryDeadline } =
      await createFundedTradeWithDynamicWindow();

    await networkHelpers.time.increaseTo(deliveryDeadline + 1n);

    await escrow.connect(operator).expireTrade(onChainTradeId);

    const trade = await escrow.getTrade(onChainTradeId);

    // EXPIRED = 6
    expect(trade.status).to.equal(6n);
  });

  it('should emit TradeExpired', async function () {
    const { escrow, operator, onChainTradeId, deliveryDeadline } =
      await createFundedTradeWithDynamicWindow();

    await networkHelpers.time.increaseTo(deliveryDeadline + 1n);

    await expect(escrow.connect(operator).expireTrade(onChainTradeId))
      .to.emit(escrow, 'TradeExpired')
      .withArgs(onChainTradeId);
  });

  it('should refund the buyer after expiration', async function () {
    const { token, escrow, operator, buyer, onChainTradeId, requiredAmount, deliveryDeadline } =
      await createFundedTradeWithDynamicWindow();

    expect(await token.balanceOf(buyer.address)).to.equal(0n);

    await networkHelpers.time.increaseTo(deliveryDeadline + 1n);

    await escrow.connect(operator).expireTrade(onChainTradeId);

    await escrow.connect(operator).refundTrade(onChainTradeId);

    const trade = await escrow.getTrade(onChainTradeId);

    // REFUNDED = 8
    expect(trade.status).to.equal(8n);

    expect(await token.balanceOf(buyer.address)).to.equal(requiredAmount);

    expect(await token.balanceOf(await escrow.getAddress())).to.equal(0n);
  });

  it('should emit TradeRefunded', async function () {
    const { escrow, operator, buyer, onChainTradeId, requiredAmount, deliveryDeadline } =
      await createFundedTradeWithDynamicWindow();

    await networkHelpers.time.increaseTo(deliveryDeadline + 1n);

    await escrow.connect(operator).expireTrade(onChainTradeId);

    await expect(escrow.connect(operator).refundTrade(onChainTradeId))
      .to.emit(escrow, 'TradeRefunded')
      .withArgs(onChainTradeId, buyer.address, requiredAmount);
  });

  it('should reject refund before expiration', async function () {
    const { escrow, operator, onChainTradeId } = await createFundedTrade();

    await expect(escrow.connect(operator).refundTrade(onChainTradeId))
      .to.be.revertedWithCustomError(escrow, 'InvalidTradeStatus')
      .withArgs(onChainTradeId, 2n, 6n);
  });

  it('should reject refunding the same trade twice', async function () {
    const { escrow, operator, onChainTradeId, deliveryDeadline } =
      await createFundedTradeWithDynamicWindow();

    await networkHelpers.time.increaseTo(deliveryDeadline + 1n);

    await escrow.connect(operator).expireTrade(onChainTradeId);

    await escrow.connect(operator).refundTrade(onChainTradeId);

    await expect(escrow.connect(operator).refundTrade(onChainTradeId))
      .to.be.revertedWithCustomError(escrow, 'InvalidTradeStatus')
      .withArgs(onChainTradeId, 8n, 6n);
  });

  it('should not pay the seller when an expired trade is refunded', async function () {
    const { token, escrow, operator, seller, onChainTradeId, deliveryDeadline } =
      await createFundedTradeWithDynamicWindow();

    await networkHelpers.time.increaseTo(deliveryDeadline + 1n);

    await escrow.connect(operator).expireTrade(onChainTradeId);

    await escrow.connect(operator).refundTrade(onChainTradeId);

    expect(await token.balanceOf(seller.address)).to.equal(0n);
  });

  it('should reject expireTrade from a non-operator', async function () {
    const { escrow, buyer, onChainTradeId } = await createFundedTradeWithDynamicWindow();

    const operatorRole = await escrow.OPERATOR_ROLE();

    await expect(escrow.connect(buyer).expireTrade(onChainTradeId))
      .to.be.revertedWithCustomError(escrow, 'AccessControlUnauthorizedAccount')
      .withArgs(buyer.address, operatorRole);
  });

  it('should reject refund while paused', async function () {
    const { escrow, operator, pauser, onChainTradeId, deliveryDeadline } =
      await createFundedTradeWithDynamicWindow();

    await networkHelpers.time.increaseTo(deliveryDeadline + 1n);

    await escrow.connect(operator).expireTrade(onChainTradeId);

    await escrow.connect(pauser).pause();

    await expect(
      escrow.connect(operator).refundTrade(onChainTradeId),
    ).to.be.revertedWithCustomError(escrow, 'EnforcedPause');
  });

  it('should reject a zero external trade ID', async function () {
    const { escrow, operator, buyer, seller } = await deployContracts();

    await expect(
      escrow
        .connect(operator)
        .createTrade(
          ethers.ZeroHash,
          buyer.address,
          seller.address,
          5000n,
          140000n,
          2_000_000_000n,
          2_000_003_600n,
        ),
    ).to.be.revertedWithCustomError(escrow, 'InvalidExternalTradeId');
  });

  it('should reject a zero buyer address', async function () {
    const { escrow, operator, seller } = await deployContracts();

    await expect(
      escrow
        .connect(operator)
        .createTrade(
          ethers.id('zero-buyer'),
          ethers.ZeroAddress,
          seller.address,
          5000n,
          140000n,
          2_000_000_000n,
          2_000_003_600n,
        ),
    ).to.be.revertedWithCustomError(escrow, 'ZeroAddress');
  });

  it('should reject a zero seller address', async function () {
    const { escrow, operator, buyer } = await deployContracts();

    await expect(
      escrow
        .connect(operator)
        .createTrade(
          ethers.id('zero-seller'),
          buyer.address,
          ethers.ZeroAddress,
          5000n,
          140000n,
          2_000_000_000n,
          2_000_003_600n,
        ),
    ).to.be.revertedWithCustomError(escrow, 'ZeroAddress');
  });

  it('should reject a trade whose calculated payment is zero', async function () {
    const { escrow, operator, buyer, seller } = await deployContracts();

    await expect(
      escrow
        .connect(operator)
        .createTrade(
          ethers.id('zero-payment'),
          buyer.address,
          seller.address,
          1n,
          1n,
          2_000_000_000n,
          2_000_003_600n,
        ),
    ).to.be.revertedWithCustomError(escrow, 'InvalidPaymentAmount');
  });

  it('should return zero for an unknown external trade ID', async function () {
    const { escrow } = await deployContracts();

    expect(await escrow.getOnChainTradeId(ethers.id('trade-does-not-exist'))).to.equal(0n);
  });

  it('should allow the admin to grant and revoke OPERATOR_ROLE', async function () {
    const { escrow, admin, buyer } = await deployContracts();

    const operatorRole = await escrow.OPERATOR_ROLE();

    await escrow.connect(admin).grantRole(operatorRole, buyer.address);

    expect(await escrow.hasRole(operatorRole, buyer.address)).to.equal(true);

    await escrow.connect(admin).revokeRole(operatorRole, buyer.address);

    expect(await escrow.hasRole(operatorRole, buyer.address)).to.equal(false);
  });

  it('should reject role administration from a non-admin', async function () {
    const { escrow, operator, buyer } = await deployContracts();

    const oracleRole = await escrow.ORACLE_ROLE();

    const adminRole = await escrow.DEFAULT_ADMIN_ROLE();

    await expect(escrow.connect(operator).grantRole(oracleRole, buyer.address))
      .to.be.revertedWithCustomError(escrow, 'AccessControlUnauthorizedAccount')
      .withArgs(operator.address, adminRole);
  });

  it('should reject cancellation while paused', async function () {
    const { escrow, operator, pauser, onChainTradeId } = await createDefaultTrade();

    await escrow.connect(pauser).pause();

    await expect(
      escrow.connect(operator).cancelTrade(onChainTradeId),
    ).to.be.revertedWithCustomError(escrow, 'EnforcedPause');
  });

  it('should reject expiration while paused', async function () {
    const { escrow, operator, pauser, onChainTradeId, deliveryDeadline } =
      await createFundedTradeWithDynamicWindow();

    await networkHelpers.time.increaseTo(deliveryDeadline + 1n);

    await escrow.connect(pauser).pause();

    await expect(
      escrow.connect(operator).expireTrade(onChainTradeId),
    ).to.be.revertedWithCustomError(escrow, 'EnforcedPause');
  });

  it('should keep escrow accounting isolated across multiple trades', async function () {
    const { token, escrow, admin, operator, oracle, buyer, seller } = await deployContracts();

    const amountPerTrade = 700000n;

    await escrow
      .connect(operator)
      .createTrade(
        ethers.id('multi-trade-1'),
        buyer.address,
        seller.address,
        5000n,
        140000n,
        2_000_000_000n,
        2_000_003_600n,
      );

    await escrow
      .connect(operator)
      .createTrade(
        ethers.id('multi-trade-2'),
        buyer.address,
        seller.address,
        5000n,
        140000n,
        2_000_000_000n,
        2_000_003_600n,
      );

    await token.connect(admin).mint(buyer.address, amountPerTrade * 2n);

    await token.connect(buyer).approve(await escrow.getAddress(), amountPerTrade * 2n);

    await escrow.connect(operator).fundTrade(1n);

    await escrow.connect(operator).fundTrade(2n);

    expect(await token.balanceOf(await escrow.getAddress())).to.equal(amountPerTrade * 2n);

    await escrow.connect(oracle).confirmDelivery(1n, 5000n, ethers.id('multi-trade-delivery-1'));

    expect(await token.balanceOf(seller.address)).to.equal(amountPerTrade);

    expect(await token.balanceOf(await escrow.getAddress())).to.equal(amountPerTrade);

    const trade1 = await escrow.getTrade(1n);

    const trade2 = await escrow.getTrade(2n);

    expect(trade1.status).to.equal(4n);

    expect(trade2.status).to.equal(2n);
  });
});
