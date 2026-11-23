/**
 * MGL850: one-time Hedera Testnet funding of every existing simulated household.
 * No backend/database writes. PREVIEW by default. --send requires explicit guard.
 * The initial TEUSD total supply must be ZERO to avoid accidental reminting.
 * Do not re-run --send after a partial batch: reconcile on-chain mint events first.
 * Install under packages/contracts/scripts/ so its `ethers` import resolves.
 */
import { Contract, JsonRpcProvider, Wallet, ZeroAddress, getAddress } from 'ethers';

const TOKEN_ADDRESS = getAddress('0x5B529135D699244D1247877353EaFdC429892bed');
const EXPECTED_MINTER = getAddress('0x30f98bBDCD8A334B0b382c0Ba521EECDb23592D4');
const EXPECTED_HOUSEHOLDS = 12; // Safety lock: review and update if the real roster changes.
const FUNDING_PER_HOUSEHOLD = 100n * 1_000_000n; // 100 TEUSD, 6 decimals.
const send = process.argv.includes('--send');
const confirmed = process.argv.includes('--confirm-12x100');
const apiBase = (process.env.B27_DEMO_API_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function getApi(path) {
  const key = process.env.TRADING_API_READ_ADMIN_KEY;
  assert(key, 'Missing TRADING_API_READ_ADMIN_KEY in backend environment.');
  const response = await fetch(`${apiBase}${path}`, {
    headers: { 'x-trading-read-key': key },
    signal: AbortSignal.timeout(12000),
  });
  assert(response.ok, `B27 API returned HTTP ${response.status} for ${path}. Start backend / check read key.`);
  return response.json();
}

async function getRoster() {
  const data = await getApi('/internal/v2/demo/users');
  assert(Array.isArray(data.users), 'Unexpected B27 users API response.');
  assert(
    data.users.length === EXPECTED_HOUSEHOLDS,
    `Roster changed: expected ${EXPECTED_HOUSEHOLDS} simulated households, got ${data.users.length}. Re-audit before funding.`,
  );

  const roster = [];
  const ids = new Set();
  const addresses = new Set();
  const errors = [];

  for (const entry of data.users) {
    const id = entry.userId;
    assert(typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id), 'Invalid household UUID from B27 API.');
    assert(!ids.has(id), `Duplicate household ID: ${id}`);
    ids.add(id);

    const period = '?from=2026-10-03T00%3A00%3A00Z&to=2026-10-04T00%3A00%3A00Z';
    const info = await getApi(`/internal/v2/demo/users/${encodeURIComponent(id)}/wallet${period}`);
    const status = info.wallet?.status ?? 'MISSING';
    const accountId = info.wallet?.hederaAccountId ?? null;
    const rawAddress = info.wallet?.evmAddress ?? null;
    let address = null;
    try {
      if (rawAddress) address = getAddress(rawAddress);
    } catch { /* Invalid address is reported below */ }

    if (status !== 'READY' || !accountId || !address) {
      errors.push(`${id}: wallet not ready (status=${status}, accountId=${!!accountId}, validEvmAddress=${!!address})`);
    } else {
      // Confirm that the stored EVM address belongs to the stored Hedera account.
      // An ERC-20 balance can otherwise be created for an unusable address.
      try {
        assert(/^0\.0\.[0-9]+$/.test(accountId), 'Invalid Hedera account ID');
        const mirror = await fetch(
          `https://testnet.mirrornode.hedera.com/api/v1/accounts/${encodeURIComponent(accountId)}`,
          { signal: AbortSignal.timeout(10000) },
        );
        assert(mirror.ok, `Mirror Node returned HTTP ${mirror.status}`);
        const account = await mirror.json();
        assert(account.account === accountId, 'Mirror Node account ID does not match');
        assert(getAddress(account.evm_address ?? '') === address, 'Mirror Node EVM address does not match');
      } catch (error) {
        errors.push(`${id}: Hedera Mirror Node account/address check failed (${error.message})`);
      }
    }
    if (address) {
      const normalized = address.toLowerCase();
      if (addresses.has(normalized)) errors.push(`Two households share EVM address ${address}.`);
      addresses.add(normalized);
      if (address === ZeroAddress) errors.push(`Zero wallet address for ${id}.`);
    }

    roster.push({ userId: id, name: entry.name, walletStatus: status, hederaAccountId: accountId, address });
  }

  console.table(roster.map(({ userId, name, walletStatus, hederaAccountId, address }) => ({
    userId, name, walletStatus, hederaAccountId, address,
  })));
  assert(errors.length === 0, `Cannot fund until wallet issues are resolved:\n${errors.join('\n')}`);
  return roster;
}

async function main() {
  if (send) {
    assert(confirmed, 'Sending requires BOTH --send and --confirm-12x100.');
  }
  const configuredToken = getAddress(process.env.B27_EXPECTED_TEUSD_ADDRESS ?? '');
  assert(configuredToken === TOKEN_ADDRESS, 'Configured TEUSD differs from verified B27 deployment.');
  const provider = new JsonRpcProvider(process.env.HEDERA_JSON_RPC_URL);
  assert((await provider.getNetwork()).chainId === 296n, 'Wrong network. Expected Hedera Testnet 296.');
  assert((await provider.getCode(TOKEN_ADDRESS)) !== '0x', 'Token contract has no deployed code.');

  const privateKey = process.env.HEDERA_DEPLOYER_PRIVATE_KEY;
  assert(/^0x[0-9a-f]{64}$/i.test(privateKey ?? ''), 'Missing/invalid dedicated Testnet deployer key.');
  const signer = new Wallet(privateKey, provider);
  assert(signer.address === EXPECTED_MINTER, 'The signer is not the known Testnet minter/admin.');

  const token = new Contract(TOKEN_ADDRESS, [
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
    'function totalSupply() view returns (uint256)',
    'function balanceOf(address) view returns (uint256)',
    'function MINTER_ROLE() view returns (bytes32)',
    'function hasRole(bytes32,address) view returns (bool)',
    'function mint(address to,uint256 amount)',
    'event Transfer(address indexed from,address indexed to,uint256 value)',
  ], signer);
  assert((await token.symbol()) === 'TEUSD', 'Incorrect token symbol.');
  assert(BigInt(await token.decimals()) === 6n, 'Incorrect token decimals.');
  const minterRole = await token.MINTER_ROLE();
  assert(await token.hasRole(minterRole, signer.address), 'Deployer does not have MINTER_ROLE.');

  console.log('=== ONE-TIME TEUSD HOUSEHOLD FUNDING ===');
  console.log('Network: Hedera Testnet (296)');
  console.log('Token:', TOKEN_ADDRESS);
  console.log('Deployer/minter:', signer.address);
  const roster = await getRoster();
  console.log('Households:', roster.length);
  console.log('Per household: 100 TEUSD (100000000 base units)');
  console.log('Planned total:', (BigInt(roster.length) * FUNDING_PER_HOUSEHOLD).toString(), 'base units');

  // The TEUSD contract was freshly deployed with totalSupply=0.
  // This guard prevents automated duplicate funding on reruns or after a partial batch.
  const supply = await token.totalSupply();
  assert(supply === 0n, `TEUSD supply is ${supply}, not 0. Stop and reconcile existing mint events; NEVER blindly rerun this batch.`);

  for (const user of roster) {
    const balance = await token.balanceOf(user.address);
    assert(balance === 0n, `${user.userId} already has a TEUSD balance. Review before minting.`);
  }

  const gas = await token.mint.estimateGas(roster[0].address, FUNDING_PER_HOUSEHOLD);
  console.log('First mint estimated gas:', gas.toString());

  if (!send) {
    console.log('PREVIEW PASS: All household wallets eligible. No mint transactions submitted.');
    console.log('For a deliberate one-time distribution, run with --send --confirm-12x100.');
    return;
  }

  console.log('SENDING: 12 separate mint transactions. Do not rerun after any success.');
  for (const [i, user] of roster.entries()) {
    // Each mint is recorded on-chain as an ERC-20 Transfer from the zero address.
    const tx = await token.mint(user.address, FUNDING_PER_HOUSEHOLD);
    console.log(`Household ${i + 1}/${roster.length} submitted:`, tx.hash);
    const receipt = await tx.wait(1);
    assert(receipt?.status === 1, `Mint receipt unsuccessful for ${user.userId}. Reconcile hash ${tx.hash} before proceeding.`);
    const matched = receipt.logs.some((log) => {
      try {
        if (getAddress(log.address) !== TOKEN_ADDRESS) return false;
        const event = token.interface.parseLog(log);
        return event?.name === 'Transfer' &&
          getAddress(event.args.from) === ZeroAddress &&
          getAddress(event.args.to) === user.address &&
          BigInt(event.args.value) === FUNDING_PER_HOUSEHOLD;
      } catch { return false; }
    });
    assert(matched, `Mint event mismatch for ${user.userId}, tx ${tx.hash}. Stop and reconcile.`);
    const balance = await token.balanceOf(user.address);
    assert(balance === FUNDING_PER_HOUSEHOLD, `Balance mismatch after ${tx.hash}. Stop and reconcile.`);
    console.log(`Household ${i + 1}/${roster.length} confirmed:`, user.address, tx.hash);
  }

  const finalSupply = await token.totalSupply();
  assert(finalSupply === BigInt(roster.length) * FUNDING_PER_HOUSEHOLD,
    `Unexpected final total supply ${finalSupply}. Reconcile transactions.`);
  console.log('PASS: All households funded. Final TEUSD supply:', finalSupply.toString(), 'base units.');
}

main().catch((error) => {
  console.error('STOP:', error.message);
  console.error('If any mint was already submitted, DO NOT RERUN --send without on-chain reconciliation.');
  process.exitCode = 1;
});
