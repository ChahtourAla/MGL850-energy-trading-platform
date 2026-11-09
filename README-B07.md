# B07 — Hedera Testnet wallet management (B06 overlay)

This patch adds new B07 files only. **Do not overwrite B06 files or the existing Prisma schema**. Apply the manual merge edits below after extracting. B07 keeps the seven original domain tables and adds one *operational recovery* table, `wallet_provisioning`.

## Architecture and security boundary

- `POST /auth/register` remains an application-only operation (B06). **No Hedera transaction occurs during registration.** A logged-in user explicitly requests provisioning with `POST /users/me/wallet/provision`.
- `GET /users/me/wallet` returns either `NOT_PROVISIONED`, `PROVISIONING`, `NEEDS_RECONCILIATION`, or `READY`. Only a READY wallet returns the public `hederaAccountId` and `evmAddress`.
- `POST /users/me/wallet/reconcile` checks the **existing transaction ID** and/or Testnet Mirror Node EVM-address lookup. It never creates another account.
- Native Hedera ECDSA secp256k1 key created by `PrivateKey.generateECDSA()`. EVM address is computed from the key and explicitly configured as the Hedera account alias (do **not** substitute `AccountId.toEvmAddress()`, the long-zero account address).
- AES-256-GCM with random 96-bit IV, 128-bit auth tag, and AAD tied to `userId` + encryption key version. `WALLET_ENCRYPTION_KEY_B64` remains only in ignored root `.env`.
- Generated private key is encrypted **before** broadcasting, and the encrypted value + immutable network `transactionId` are stored in `wallet_provisioning`. Finalization atomically creates the `wallets` record and deletes the provisioning record.
- Failure after submission conservatively becomes `NEEDS_RECONCILIATION`; **no automatic retry of createAccount**. If a receipt is older than consensus-node retention, recovery attempts Testnet Mirror Node account lookup by the EVM alias. Delayed indexing, database outages, and lost operator credentials may still require manual intervention.
- Every actual on-chain provisioning action costs the operator Testnet HBAR. **Provision only known test users**; never automatically create Testnet accounts for every registration without controlling account creation abuse. This is a development prototype, not production key custody.

## 1 — Preflight

From repository root:

```powershell
cd C:\Users\AV11150\Desktop\MGL850\p2p-energy-trading-platform
git branch --show-current
git status --short
docker compose --env-file .env -f infra/docker-compose.yml ps
```

Require `feature/nestjs-backend`, clean worktree, running PostgreSQL.

## 2 — Extract overlay

Download the supplied `B07-wallet-management.zip` to Downloads, then:

```powershell
$patch = Join-Path $HOME 'Downloads\B07-wallet-management.zip'
if (-not (Test-Path $patch)) { throw "Missing ZIP: $patch" }
if (Test-Path 'apps\backend\src\wallets') {
  throw 'Wallets folder already exists; review before extraction'
}
Expand-Archive -LiteralPath $patch -DestinationPath (Get-Location).Path
```

Files added:

```
apps/backend/src/wallets/wallet.types.ts
apps/backend/src/wallets/wallet-crypto.service.ts
apps/backend/src/wallets/hedera-wallet.gateway.ts
apps/backend/src/wallets/wallets.service.ts
apps/backend/src/wallets/wallets.controller.ts
apps/backend/src/wallets/wallets.module.ts
apps/backend/src/wallets/wallet-crypto.spec.ts
apps/backend/test/wallets.e2e-spec.ts
apps/backend/scripts/wallet-smoke.mjs
README-B07.md
```

## 3 — Install Hiero JavaScript SDK

```powershell
pnpm --filter @energy-trading/backend add '@hiero-ledger/sdk@2.90.1'
```

Review any new `pnpm-workspace.yaml` `allowBuilds` placeholders and decide explicitly true/false based on the exact installed package, not blind approval.

## 4 — Add durable provisioning schema

Open `database/schema.prisma`. **Inside the existing `model User`**, add:

```prisma
  walletProvisioning WalletProvisioning?
```

**At the end** of `database/schema.prisma`, append:

```prisma
model WalletProvisioning {
  id                  String   @id @default(uuid()) @db.Uuid
  userId              String   @unique @map("user_id") @db.Uuid
  publicKey           String   @map("public_key") @db.Text
  evmAddress          String   @unique @map("evm_address") @db.VarChar(42)
  encryptedPrivateKey String   @map("encrypted_private_key") @db.Text
  encryptionIv        String   @map("encryption_iv") @db.Text
  encryptionAuthTag   String   @map("encryption_auth_tag") @db.Text
  keyVersion          Int      @default(1) @map("key_version")
  transactionId       String   @unique @map("transaction_id") @db.VarChar(128)
  state               String   @default("PREPARED") @db.VarChar(32)
  createdAt           DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt           DateTime @updatedAt @map("updated_at") @db.Timestamptz(3)

  user User @relation(fields: [userId], references: [id], onDelete: Restrict)

  @@index([state, createdAt])
  @@map("wallet_provisioning")
}
```

Validate and create the migration **without applying it yet**:

```powershell
pnpm exec prisma validate --config prisma7.config.ts
pnpm exec prisma migrate dev --config prisma7.config.ts --name wallet_provisioning --create-only
```

Locate the newly generated `migration.sql`, and append the following before applying:

```sql
ALTER TABLE "wallet_provisioning"
ADD CONSTRAINT "wallet_provisioning_state_allowed"
CHECK ("state" IN ('PREPARED', 'SUBMITTED', 'NEEDS_RECONCILIATION'));
```

Apply and generate:

```powershell
pnpm exec prisma migrate dev --config prisma7.config.ts
pnpm exec prisma migrate status --config prisma7.config.ts
pnpm exec prisma generate --config prisma7.config.ts
```

Do not modify or reset the existing B04 migration. Do not use `prisma db push` to bypass the custom check.

## 5 — Merge AuthModule safely (do not overwrite existing file)

File: `apps/backend/src/auth/auth.module.ts`.

Add imports:

```ts
import { WalletsModule } from '../wallets/wallets.module.js';
import { WalletsController } from '../wallets/wallets.controller.js';
```

Inside existing `@Module` metadata:

- Add `WalletsModule` to `imports` alongside `UsersModule`.
- Add `WalletsController` to `controllers` alongside `AuthController` and `UsersController`.
- Keep all existing JWT and Throttler configuration as-is.

WalletsController is hosted by AuthModule to use its JWT guard without circular module imports. Do **not** import `AuthModule` from `WalletsModule`.

## 6 — Update users' public wallet status

File: `apps/backend/src/users/users.service.ts`.

Inside `AUTH_USER_SELECT`, after `updatedAt: true,`, add:

```ts
  wallet: { select: { id: true } },
  walletProvisioning: { select: { state: true } },
```

The `PublicUser.walletStatus` field currently has the literal type `'NOT_PROVISIONED'`. Replace it with:

```ts
walletStatus: 'NOT_PROVISIONED' | 'PROVISIONING' | 'NEEDS_RECONCILIATION' | 'READY';
```

Inside `toPublicUser`, replace the hardcoded `walletStatus: 'NOT_PROVISIONED'` line with:

```ts
walletStatus: user.wallet
  ? 'READY'
  : user.walletProvisioning?.state === 'NEEDS_RECONCILIATION'
    ? 'NEEDS_RECONCILIATION'
    : user.walletProvisioning
      ? 'PROVISIONING'
      : 'NOT_PROVISIONED',
```

The B06 mock-user responses have no wallet properties; optional chaining handles them and previous tests should still pass. Never expose wallet ciphertext by selecting it into public profiles.

## 7 — Extend configuration

File `apps/backend/src/config/environment.schema.ts` (inside the existing `z.object({...})`). Add:

```ts
HEDERA_NETWORK: z.enum(['testnet']).optional(),
HEDERA_OPERATOR_ID: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
HEDERA_OPERATOR_KEY: z.string().min(20).optional(),
WALLET_ENCRYPTION_KEY_B64: z.string().optional(),
WALLET_PROVISIONING_ENABLED: z.enum(['true', 'false']).optional(),
```

These are optional so B01–B06 tests keep running without Hedera keys. Provisioning itself fails closed unless `WALLET_PROVISIONING_ENABLED=true`, `HEDERA_NETWORK=testnet`, and operator/key material are present.



In root `.env.example`, add **comments, not real secrets**:

```dotenv
# HEDERA_NETWORK=testnet
# HEDERA_OPERATOR_ID=0.0.123456
# HEDERA_OPERATOR_KEY=your_testnet_operator_private_key
# WALLET_ENCRYPTION_KEY_B64=base64_of_32_random_bytes
# WALLET_PROVISIONING_ENABLED=false
```

In your **ignored root `.env`**, add `HEDERA_NETWORK=testnet` and the real operator ID/key from your own Testnet account. **Never paste operator keys or encryption keys into chat or commit them.**

Generate a new 32-byte encryption key locally:

```powershell
if (Select-String -Path .env -Pattern '^WALLET_ENCRYPTION_KEY_B64=' -Quiet) {
  Write-Host 'Existing wallet encryption key preserved (DO NOT ROTATE without migration)'
} else {
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  $encoded = [Convert]::ToBase64String($bytes)
  Add-Content -Path .env -Value "WALLET_ENCRYPTION_KEY_B64=$encoded"
  Remove-Variable encoded
  Write-Host 'Created wallet encryption key in ignored .env'
}
```

Add `WALLET_PROVISIONING_ENABLED=false` to `.env` while running unit tests. Enable it **only when you are ready to spend real Testnet HBAR** for a test user. Set `true` and restart NestJS for the live smoke test.

### Testnet operator requirements

The Hedera operator ID/key pair must be valid on Testnet, and the account must have enough HBAR to pay **account creation network fees**. The newly created user wallet starts with 0 HBAR; any future funding is handled separately. The EVM address is the 20-byte key-derived address set as alias, not the long-zero account ID address. This is important for EVM contracts.

## 8 — Build and tests (no network fees)

```powershell
pnpm --filter @energy-trading/backend build
pnpm --filter @energy-trading/backend typecheck
pnpm --filter @energy-trading/backend exec vitest run src/wallets/wallet-crypto.spec.ts test/wallets.e2e-spec.ts
pnpm --filter @energy-trading/backend test
pnpm --filter @energy-trading/backend test:e2e
pnpm --filter @energy-trading/backend lint
```

Target new tests: 5 wallet-encryption + 7 wallet-HTTP tests = **12 new B07 tests**; full suite target **84** (72 previous + 12). Target counts are not verified against your Windows environment. The B07 HTTP test uses a mock Hedera gateway and in-memory mocked Prisma methods, so it does not incur Testnet fees. The **real network** test is separate and opt-in.

## 9 — Real Testnet smoke test (explicit opt-in, not reversible)

Start NestJS from project root (after setting real operator credentials, encryption key, `HEDERA_NETWORK=testnet` and `WALLET_PROVISIONING_ENABLED=true`):

```powershell
pnpm --filter @energy-trading/backend start:dev
```

In a second PowerShell window, from repo root:

```powershell
$env:B07_RUN_LIVE_TESTNET='YES'
Push-Location apps/backend
try {
  node --env-file=../../.env scripts/wallet-smoke.mjs
} finally {
  Pop-Location
  Remove-Item Env:\B07_RUN_LIVE_TESTNET -ErrorAction SilentlyContinue
}
```

The script creates a **real Testnet account** and **deliberately preserves the user/wallet DB record**, because deleting local custody while leaving a real on-chain identity would orphan it. It prints the test user email and account ID but **never** prints private keys. Do not rerun casually: each run creates a new user/account and costs Testnet HBAR.

Expected success:

```text
B07 PASS: real Testnet wallet created and encrypted key stored in PostgreSQL
B07 PASS: public identifiers match; staging record removed
B07 PASS: unauthenticated access blocked
```

If the script reports an uncertain result, **do not restart provisioning from scratch**. Keep the DB record; use the same user's JWT to call `POST /users/me/wallet/reconcile`. The staging row holds the transaction ID and encrypted key for reconciliation. Network mirror nodes may take time to index fresh accounts.

## 10 — Commit once verified

```powershell
git status --short
git diff --check
git check-ignore -v .env
git add README-B07.md database/schema.prisma database/migrations
git add apps/backend/src/wallets apps/backend/test/wallets.e2e-spec.ts apps/backend/scripts/wallet-smoke.mjs
git add apps/backend/src/auth/auth.module.ts apps/backend/src/users/users.service.ts apps/backend/src/config/environment.schema.ts
git add apps/backend/package.json pnpm-lock.yaml .env.example
git diff --cached --check
git diff --cached --stat
```

If `pnpm-workspace.yaml` changed, review its script permissions before adding it. Confirm no secret or generated Prisma code is staged.

```powershell
git commit -m 'feat(backend): add secure Hedera Testnet wallet provisioning'
git status
```

## Important limitations / next steps

- The real SDK has been checked against current public docs, but the overlay cannot be compiled here against the private, up-to-date B06 Git worktree. **Build, typecheck, and runtime validation must happen on your machine**; send error output for exact fixes.
- Key management uses a single environment-managed key and Node.js strings. For production use, migrate to a KMS/HSM and explicit key rotation, stricter audit policy, rate limiting, and operator billing controls.
- Registration creates a user first, then wallet provisioning is explicitly initiated. Later, the frontend can orchestrate those two steps. Do not yet describe `POST /auth/register` as an atomic end-to-end Hedera registration.
- Account creation is NOT automatically retried if submission or receipt becomes uncertain. Mirror lookup and admin reconciliation may still be required. Do not interpret an unavailable receipt as proof that the transaction failed.
- The in-memory NestJS rate limiter isn't a distributed limit. Before public deployments, add verified email gating, quotas, and server-side account-creation authorization to reduce fee abuse.
- `WalletCryptoService.decrypt` is an **internal API only** for later signing and must never be used by controllers or returned in JSON responses.
- Do not store the platform operator private key in the database; never log keys, JWTs, or encryption plaintext.
