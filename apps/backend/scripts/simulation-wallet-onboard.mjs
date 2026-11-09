// B10 operator CLI. Preview by default; ONLY --execute can create real Testnet accounts.
// Uses the B10 API, which delegates to B07's durable encrypted-key/transaction-ID protocol.
import { readFile } from 'node:fs/promises';

const [, , registryPath, ...options] = process.argv;
const HELP = `Usage:
  node --env-file=../../.env scripts/simulation-wallet-onboard.mjs <user-registry.json>
  B10_LIVE_TESTNET=YES node ... <user-registry.json> --execute --max-new=12
  node ... <user-registry.json> --reconcile
Default is a READ-ONLY plan. No command retries account creation.`;
if (!registryPath || options.some((x) => x === '--help' || x === '-h')) {
  console.log(HELP);
  process.exit(registryPath ? 0 : 1);
}
if (options.some((x) => !['--execute', '--reconcile'].includes(x) && !/^--max-new=\d+$/.test(x))) {
  throw new Error(`Unknown option.\n${HELP}`);
}
const execute = options.includes('--execute');
const reconcile = options.includes('--reconcile');
if (execute && reconcile) throw new Error('--execute and --reconcile must not be combined');
const maxValues = options.filter((x) => x.startsWith('--max-new='));
if (maxValues.length > 1 || (!execute && maxValues.length)) {
  throw new Error('--max-new is only for --execute and may appear once');
}
const maxNew = maxValues.length ? Number(maxValues[0].split('=')[1]) : 0;
if (execute && (!Number.isSafeInteger(maxNew) || maxNew < 1 || maxNew > 12)) {
  throw new Error('--execute requires --max-new=N (1–12), explicitly approving the maximum number of NEW Testnet accounts');
}
const key = process.env.SIMULATION_WALLET_ADMIN_KEY;
if (!key || key.length < 32) throw new Error('SIMULATION_WALLET_ADMIN_KEY (32+ chars) is required');
const baseUrl = process.env.BACKEND_URL ?? 'http://127.0.0.1:3001';
const parsedUrl = new URL(baseUrl);
if (parsedUrl.protocol !== 'https:' &&
    !(parsedUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsedUrl.hostname))) {
  throw new Error('Use HTTPS outside localhost; never send the administrator key over remote HTTP');
}
const registry = JSON.parse(await readFile(registryPath, 'utf8'));
if (!registry || !Array.isArray(registry.users) || registry.users.length < 1 || registry.users.length > 12) {
  throw new Error('Registry must contain 1–12 households; use the original B08 registry');
}
const userIds = registry.users.map((x) => x.userId);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (userIds.some((x) => typeof x !== 'string' || !uuid.test(x)) ||
    new Set(userIds.map((x) => x.toLowerCase())).size !== userIds.length) {
  throw new Error('Invalid or duplicate registry UUIDs');
}
async function call(route, body) {
  const response = await fetch(new URL(`/internal/simulation/wallets/${route}`, parsedUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-simulation-wallet-key': key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(route === 'provision' ? 120_000 : 30_000),
  });
  let data;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) {
    const message = typeof data?.message === 'string' ? data.message : `HTTP ${response.status}`;
    throw new Error(`${route}: HTTP ${response.status} — ${message}`);
  }
  return data;
}
function report(plan) {
  console.log(`B10 PLAN: ${plan.total} households; READY=${plan.ready}, NEW=${plan.notProvisioned}, PENDING=${plan.pending}`);
  for (const u of plan.users) {
    console.log(`  ${u.userId}  ${u.status}${u.hederaAccountId ? `  ${u.hederaAccountId}` : ''}`);
  }
}
const initial = await call('plan', { userIds });
report(initial);
if (!execute && !reconcile) {
  console.log('B10 DRY RUN: no Testnet accounts created. Review the plan before authorizing spending.');
  process.exit(0);
}
if (process.env.HEDERA_NETWORK !== 'testnet' || process.env.WALLET_PROVISIONING_ENABLED !== 'true') {
  throw new Error('HEDERA_NETWORK=testnet and WALLET_PROVISIONING_ENABLED=true required in this terminal and on the backend');
}
if (reconcile) {
  const pending = initial.users.filter((u) => u.status === 'PROVISIONING' || u.status === 'NEEDS_RECONCILIATION');
  for (const user of pending) {
    // Reconciliation can update PostgreSQL but never sends a new AccountCreate transaction.
    const result = await call('reconcile', { userId: user.userId });
    console.log(`B10 RECONCILE: ${user.userId} → ${result.status}${result.hederaAccountId ? ` (${result.hederaAccountId})` : ''}`);
  }
  report(await call('plan', { userIds }));
  process.exit(0);
}
if (process.env.B10_LIVE_TESTNET !== 'YES') {
  throw new Error('Refusing to spend Testnet HBAR without B10_LIVE_TESTNET=YES');
}
if (process.env.SIMULATION_WALLET_ONBOARDING_ENABLED !== 'true') {
  throw new Error('SIMULATION_WALLET_ONBOARDING_ENABLED=true required locally and in restarted backend');
}
if (initial.pending !== 0) {
  throw new Error('A previous Hedera attempt is pending. Run --reconcile; never submit another transaction blindly.');
}
if (initial.notProvisioned > maxNew) {
  throw new Error(`Plan needs ${initial.notProvisioned} new accounts, exceeds explicitly approved --max-new=${maxNew}`);
}
console.log(`B10 LIVE: explicitly approved up to ${maxNew} new Hedera Testnet account creations. Network fees will be paid by operator.`);
for (const user of initial.users.filter((u) => u.status === 'NOT_PROVISIONED')) {
  try {
    const result = await call('provision', {
      userId: user.userId,
      confirmation: `CREATE_TESTNET_ACCOUNT_FOR_${user.userId}`,
    });
    if (result.status !== 'READY') throw new Error('Result is not confirmed READY');
    console.log(`B10 CREATED: ${user.userId} → ${result.hederaAccountId} (${result.evmAddress})`);
  } catch (error) {
    console.error(`B10 STOP: ${user.userId} outcome is not confirmed. DO NOT rerun --execute before inspecting --reconcile.`);
    throw error;
  }
}
const finalPlan = await call('plan', { userIds });
report(finalPlan);
if (finalPlan.ready !== finalPlan.total) {
  throw new Error('Not all households are READY. Inspect --reconcile; never invent wallet IDs.');
}
console.log(`B10 PASS: all ${finalPlan.ready} simulated households now have verified Testnet wallet records`);
