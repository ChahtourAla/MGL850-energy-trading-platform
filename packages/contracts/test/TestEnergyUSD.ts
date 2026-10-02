import { expect } from 'chai';
import { network } from 'hardhat';

const { ethers } = await network.connect();

describe('TestEnergyUSD', function () {
  async function deployToken() {
    const [admin, buyer] = await ethers.getSigners();

    const token = await ethers.deployContract('TestEnergyUSD', [admin.address]);

    await token.waitForDeployment();

    return {
      token,
      admin,
      buyer,
    };
  }

  it('should use 6 decimals', async function () {
    const { token } = await deployToken();

    expect(await token.decimals()).to.equal(6n);
  });

  it('should grant admin and minter roles to the initial admin', async function () {
    const { token, admin } = await deployToken();

    const adminRole = await token.DEFAULT_ADMIN_ROLE();

    const minterRole = await token.MINTER_ROLE();

    expect(await token.hasRole(adminRole, admin.address)).to.equal(true);

    expect(await token.hasRole(minterRole, admin.address)).to.equal(true);
  });

  it('should allow the minter to mint tokens', async function () {
    const { token, buyer } = await deployToken();

    const amount = 1_000_000n;

    await token.mint(buyer.address, amount);

    expect(await token.balanceOf(buyer.address)).to.equal(amount);
  });

  it('should reject minting from a non-minter', async function () {
    const { token, buyer } = await deployToken();

    const minterRole = await token.MINTER_ROLE();

    await expect(token.connect(buyer).mint(buyer.address, 1_000_000n))
      .to.be.revertedWithCustomError(token, 'AccessControlUnauthorizedAccount')
      .withArgs(buyer.address, minterRole);
  });

  it('should reject minting zero tokens', async function () {
    const { token, admin, buyer } = await deployToken();

    await expect(token.connect(admin).mint(buyer.address, 0n)).to.be.revertedWithCustomError(
      token,
      'ZeroAmount',
    );
  });

  it('should reject minting to the zero address', async function () {
    const { token, admin } = await deployToken();

    await expect(
      token.connect(admin).mint(ethers.ZeroAddress, 1_000_000n),
    ).to.be.revertedWithCustomError(token, 'ZeroAddress');
  });
});
