# B10 — Simulation Wallet Onboarding (Hedera Testnet)

**Base:** your committed B09 backend (`3d75cef`), 118 passing tests. **Implementation overlay:** new files only; merge two changes into existing files manually. **Target:** 18 service tests + 8 HTTP tests = 26 B10 tests; total 144 backend tests. These tests must be run in your Windows checkout; they have NOT been run against its Prisma-generated client here.

## Scope and the on-chain safety boundary

The 12 households imported by B08 are **SIMULATED** rows and cannot log in via B06. B09 correctly refuses an energy snapshot whose EVM address is not backed by a B07 wallet row. B10 provides explicit, operator-authorized creation of **real Hedera Testnet accounts** for these simulation rows, reusing B07's encrypted key and durable transaction-ID protocol. It never invents account identifiers.

- **No schema migration**: existing `users.account_origin`, `wallets` and `wallet_provisioning` tables are sufficient.
- **Separate admin credential**: `x-simulation-wallet-key` / `SIMULATION_WALLET_ADMIN_KEY` is NOT the B08/B09 import secret or a user JWT.
- **Two feature gates**: new account creation requires both `WALLET_PROVISIONING_ENABLED=true` (existing B07) and `SIMULATION_WALLET_ONBOARDING_ENABLED=true` (new B10), plus `HEDERA_NETWORK=testnet`.
- **One confirmed wallet per API request**, with an exact user-UUID-specific confirmation string; the API refuses registered users, missing users, mixed-origin plans, and malformed requests.
- **Preview first**: the CLI defaults to zero blockchain transactions. `--execute --max-new=N` additionally requires `B10_LIVE_TESTNET=YES`. `max-new` is a per-invocation maximum number of **new** accounts, not a HBAR spending estimate or a global expenditure limit. Check your operator's HBAR balance independently before enabling. Account-creation fees may vary.
- **No blind retry**: if B07 marks an attempt pending or network confirmation is unknown, do not repeat creation. `--reconcile` reads the stored transaction/alias (but never re-broadcasts). The script stops on the first error; creation across 12 users is **not one atomic chain/DB transaction**. Accounts created before a failure remain created.
- **Private keys**: B07 generates ECDSA secp256k1 keys, encrypts them before broadcast (AES-256-GCM), and persists only the encrypted material. B10 responses and CLI logs contain only UUIDs, account IDs, EVM addresses, and statuses.
- **No auto-funding**: the B07 flow creates each account with initial balance 0 HBAR. You will need a separately approved funding policy later for transaction fees and trade participation.
- Restrict `/internal/simulation/wallets/*` to local/trusted networks and use HTTPS if accessed remotely. Never publish the key. After onboarding, disable the B10 creation flag and restart the server.

## 1. Prerequisites

In PowerShell at the repository root:

```powershell
cd C:\Users\AV11150\Desktop\MGL850\p2p-energy-trading-platform

git log -1 --oneline
pnpm exec prisma migrate status --config prisma7.config.ts
git status --short
```

Expect B09 commit `3d75cef` and an up-to-date database. Keep the unrelated `.agents/`, `.claude/`, `.windsurf/`, and `skills-lock.json` untracked. Do not reset PostgreSQL or remove the B07 operator wallet/encryption key.

## 2. Download and extract the overlay

Download `B10-simulation-wallet-onboarding.zip` and place it in Downloads. Then:

```powershell
$patch = Join-Path $HOME 'Downloads\B10-simulation-wallet-onboarding.zip'
if (-not (Test-Path $patch)) { throw 'B10 ZIP not found' }
if (Test-Path 'apps\backend\src\simulation-wallets') {
  throw 'Simulation-wallets directory exists. Inspect changes before overwriting.'
}
Expand-Archive -LiteralPath $patch -DestinationPath (Get-Location).Path
```

New files:

```text
apps/backend/src/simulation-wallets/
  simulation-wallet-admin.guard.ts
  simulation-wallet-onboarding.service.ts
  simulation-wallet-onboarding.controller.ts
  simulation-wallet-onboarding.module.ts
  simulation-wallet-onboarding.service.spec.ts
apps/backend/test/simulation-wallet-onboarding.e2e-spec.ts
apps/backend/scripts/simulation-wallet-onboard.mjs
README-B10.md
```

No new npm packages or Prisma changes are needed.

## 3. Register the NestJS module

Open `apps/backend/src/app.module.ts`. Add this import next to the other feature modules:

```typescript
import { SimulationWalletOnboardingModule } from './simulation-wallets/simulation-wallet-onboarding.module.js';
```

Add `SimulationWalletOnboardingModule` to the existing `@Module({ imports: [ ... ] })` list. **Keep all B01–B09 imports intact**, especially `AuthModule`, `WalletsModule` (used transitively), `RegistryImportModule` and `EnergyImportModule`.

## 4. Add configuration validation and secrets

Open `apps/backend/src/config/environment.schema.ts`, inside the existing Zod object add:

```typescript
SIMULATION_WALLET_ADMIN_KEY: z.string().min(32).optional(),
SIMULATION_WALLET_ONBOARDING_ENABLED: z.enum(['true', 'false']).optional(),
```

The settings are optional so an installation without B10 credentials can start. All B10 admin requests fail closed until the secret is configured; account creation remains disabled unless the flag is exactly the string `'true'`.

Add **commented placeholders only** to `.env.example`:

```dotenv
# SIMULATION_WALLET_ADMIN_KEY=replace_with_independent_32_plus_character_secret
SIMULATION_WALLET_ONBOARDING_ENABLED=false
```

Generate a **separate** administrator secret in the ignored root `.env` without printing it (Windows PowerShell):

```powershell
if (-not (Select-String -Path '.env' -Pattern '^SIMULATION_WALLET_ADMIN_KEY=' -Quiet)) {
  $bytes = [byte[]]::new(48)
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  $secret = [Convert]::ToBase64String($bytes)
  Add-Content -Path '.env' -Value "SIMULATION_WALLET_ADMIN_KEY=$secret"
  Remove-Variable secret
  Write-Host 'B10 administrator secret configured; value hidden.'
}
```

While testing the preview, leave:

```dotenv
SIMULATION_WALLET_ONBOARDING_ENABLED=false
WALLET_PROVISIONING_ENABLED=false
HEDERA_NETWORK=testnet
```

If the new B10 flag is missing, add the line with `false` to `.env`. Ensure the real `.env` is ignored:

```powershell
git check-ignore -v .env
```

Keep the existing `HEDERA_OPERATOR_ID`, `HEDERA_OPERATOR_KEY`, `WALLET_ENCRYPTION_KEY_B64`, and `DATABASE_URL` secure and unchanged. You do NOT need to generate a second operator account.

## 5. Build and automated tests (no network spending)

```powershell
pnpm --filter @energy-trading/backend build
pnpm --filter @energy-trading/backend typecheck

pnpm --filter @energy-trading/backend exec vitest run `
  src/simulation-wallets/simulation-wallet-onboarding.service.spec.ts `
  test/simulation-wallet-onboarding.e2e-spec.ts

pnpm --filter @energy-trading/backend test
pnpm --filter @energy-trading/backend lint
```

**Targets**: 26 new B10 tests; 144 backend tests across 17 test files. The tests use mocked B07/Prisma operations: they NEVER broadcast a real Hedera account creation.

Check the Prisma DB remains current:

```powershell
pnpm exec prisma migrate status --config prisma7.config.ts
```

Do **not** create a migration for B10.

## 6. Preview the 12-household onboarding plan (zero HBAR spent)

Restart the backend (Terminal 1):

```powershell
pnpm --filter @energy-trading/backend start:dev
```

With the B08 registry from your successful Python-to-PostgreSQL import still available at `$env:TEMP\b08-generated-users.json`, open Terminal 2:

```powershell
cd C:\Users\AV11150\Desktop\MGL850\p2p-energy-trading-platform
$source = Join-Path $env:TEMP 'b08-generated-users.json'
if (-not (Test-Path $source)) { throw 'B08 registry missing; regenerate the SAME 12 users before continuing' }

Push-Location apps/backend
try {
  node --env-file=../../.env scripts/simulation-wallet-onboard.mjs $source
}
finally { Pop-Location }
```

Expected *for your current walletless households*:

```text
B10 PLAN: 12 households; READY=0, NEW=12, PENDING=0
...
B10 DRY RUN: no Testnet accounts created. Review the plan before authorizing spending.
```

If any account is already READY, it is not recreated. If any account is pending, reconcile it BEFORE executing. If you see a REGISTERED/missing identity, stop and verify the original B08 registry matches the database; do not replace its IDs.

## 7. Opt in to real Hedera Testnet creation

**This section causes 12 real Hedera Testnet account-creation transactions**, unless some accounts are already READY. Hedera network fees will be charged to the operator's Testnet HBAR balance. Verify that you deliberately want this, the operator is funded, and the account creation operator fee is acceptable. The code has no guaranteed monetary spending ceiling.

Edit your ignored root `.env`:

```dotenv
HEDERA_NETWORK=testnet
WALLET_PROVISIONING_ENABLED=true
SIMULATION_WALLET_ONBOARDING_ENABLED=true
```

Keep all prior secrets and DB settings. **Restart NestJS**, otherwise the server may still be using old env values.

From a second terminal at repo root:

```powershell
$source = Join-Path $env:TEMP 'b08-generated-users.json'
$env:B10_LIVE_TESTNET = 'YES'

Push-Location apps/backend
try {
  node --env-file=../../.env scripts/simulation-wallet-onboard.mjs $source --execute --max-new=12
}
finally {
  Pop-Location
  Remove-Item Env:\B10_LIVE_TESTNET -ErrorAction SilentlyContinue
}
```

This runs sequentially, one confirmed user per request. The controller refuses creation without the exact body confirmation `CREATE_TESTNET_ACCOUNT_FOR_<uuid>`. It stops immediately if a response is uncertain and does **not** automatically retry.

Expected success after all 12:

```text
B10 PLAN: 12 households; READY=12, NEW=0, PENDING=0
B10 PASS: all 12 simulated households now have verified Testnet wallet records
```

### If an account creation fails or times out

**Do NOT repeat `--execute` immediately.** A timeout could mean that the transaction reached consensus and the response was lost. Inspect and reconcile the exact existing transaction first:

```powershell
$source = Join-Path $env:TEMP 'b08-generated-users.json'
Push-Location apps/backend
try {
  node --env-file=../../.env scripts/simulation-wallet-onboard.mjs $source --reconcile
}
finally { Pop-Location }
```

`--reconcile` uses B07's recorded transaction ID and mirror-node alias lookup. It never creates a new account. If the status remains `NEEDS_RECONCILIATION`, **stop and inspect the stored transaction with an operator**. Do not delete provisioning rows, change keys, or create a replacement wallet based only on a timeout or a mirror-node 404. Note that a crash between the PREPARED and SUBMITTED stages may require manual investigation; the current B07 protocol deliberately does not re-broadcast the transaction.

Once every entry is either `READY` or safely resolved, rerun the plan. You may run `--execute` again only when `PENDING=0`, and only to create the remaining `NOT_PROVISIONED` accounts after a fresh explicit maximum is approved.

## 8. Export and validate the wallet-enriched registry

This uses the read-only B09 exporter, which copies only wallet public identifiers from verified `wallets` DB rows. No private keys or credentials are exported.

From repo root:

```powershell
$root = (Get-Location).Path
$env:PYTHONPATH = "$root\packages\shared\python;$root\services\data-generator"
$source = Join-Path $env:TEMP 'b08-generated-users.json'
$output = Join-Path $env:TEMP ('b10-wallet-ready-' + [guid]::NewGuid().ToString('N') + '.json')

Push-Location apps/backend
try {
  node --env-file=../../.env scripts/export-wallet-ready-registry.mjs $source $output
}
finally { Pop-Location }

python -m data_generator.cli validate-users --input $output --require-wallets
node apps/backend/scripts/validate-contract.mjs user-registry $output
```

Expect `B09 PASS: exported 12 wallet-ready households ...` and successful Python/B05 validations. **Do not upload or commit wallet-enriched registry exports containing personal details unless appropriate**, even though private keys are excluded.

B11 will automate snapshot generation and import for all 12 funded/verified participants. For now B10 ends with the trusted exported registry.

## 9. Turn OFF creation and commit

After successful onboarding, set `SIMULATION_WALLET_ONBOARDING_ENABLED=false` in `.env` and restart the backend. Leave `WALLET_PROVISIONING_ENABLED=true` temporarily only if B07 self-registration provisioning is still required. Reconciliation needs the B07 flag enabled.

```powershell
git status --short
git diff --check
git check-ignore -v .env

git add README-B10.md
git add apps/backend/src/simulation-wallets
git add apps/backend/test/simulation-wallet-onboarding.e2e-spec.ts
git add apps/backend/scripts/simulation-wallet-onboard.mjs
git add apps/backend/src/app.module.ts
git add apps/backend/src/config/environment.schema.ts
git add .env.example

git diff --cached --check
git diff --cached --stat
git commit -m "feat(backend): onboard simulated households with verified Testnet wallets"
git log -1 --oneline
git status --short
```

Exclude unrelated `.agents/`, `.claude/`, `.windsurf/`, and `skills-lock.json`. Keep root `.env` ignored. This phase never deletes or replaces B07 wallets. Keep `WALLET_ENCRYPTION_KEY_B64` backed up securely: losing it makes the encrypted wallet private keys unrecoverable.
