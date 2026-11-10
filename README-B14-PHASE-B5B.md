# B14 Phase B5-B — Secure TestEnergyUSD mint signing (NO broadcast)

This overlay adds three files; it does not modify the B12/B13/B14 A–B5A implementation, deployed contracts, Prisma schema, or dependencies.

## Goal

Use the already-staged `MINT_TEUSD` PostgreSQL intent to locally sign exactly one testnet `mint(buyer,250232)` transaction and securely store its encrypted signed envelope **without submitting it to Hedera**. Preview runs read-only. Separate later B5-C code will handle broadcast and reconciliation using only the stored hash and raw bytes.

## Verified context

- B12 match: `60bd8ca9-bb7d-534f-8564-468e4a5f0b3a`.
- Existing B5-A mint intent: `a6ded8be-45b8-4833-99c0-fc9e93771cff`, `PLANNED`.
- Operator HBAR funding intent already `CONFIRMED` and on-chain buyer HBAR balance `0.2`.
- Admin/minter EVM address: `0x30f98bBDCD8A334B0b382c0Ba521EECDb23592D4`.
- Buyer: `0x255d93780b72aeb3c29187765d900eae4cf67f31`.
- Canonical TestEnergyUSD: `0x9Ada96be34382a1554C0bE4Fb35cC010C05A5C7c`.
- Token mint amount `250232` micro units = `0.250232 TEUSD`.

## Files

- `apps/backend/scripts/b14-teusd-mint-seal-core.mjs`
- `apps/backend/scripts/b14-teusd-mint-seal-core.test.mjs`
- `apps/backend/scripts/b14-teusd-mint-seal.mjs`

## Read-only verification

Run from repo root:

```powershell
node --test apps/backend/scripts/b14-teusd-mint-seal-core.test.mjs
node --check apps/backend/scripts/b14-teusd-mint-seal.mjs
pnpm --filter @energy-trading/backend build
pnpm --filter @energy-trading/backend typecheck
pnpm --filter @energy-trading/backend test
pnpm --filter @energy-trading/backend lint
```

Then the **single-line** command inside `apps/backend` (PowerShell safe):

```powershell
Push-Location apps/backend
try {
  node --env-file=../../.env --env-file=../../packages/contracts/.env scripts/b14-teusd-mint-seal.mjs --match-id "60bd8ca9-bb7d-534f-8564-468e4a5f0b3a" --intent-id "a6ded8be-45b8-4833-99c0-fc9e93771cff" --admin-address "0x30f98bBDCD8A334B0b382c0Ba521EECDb23592D4"
  if ($LASTEXITCODE -ne 0) { throw "B14 B5-B preview failed" }
} finally { Pop-Location }
```

Expected: `B14 B5-B PREVIEW PASS`, `journalStatus:"PLANNED"`, `mintUnits:"250232"`, `action:"PREVIEW_ONLY"`, exact nonce/gas quote supplied by Hedera. A pending nonce, changed balance/role/trade, or gas fee above 0.75 Testnet HBAR stops the process.

## Optional later: local encrypted sealing

**Do not run until preview output has been independently verified.** Requires stable `B14_SIGNED_TX_KEY_B64` in git-ignored `packages/contracts/.env`, as set up during B3. Reuse it—do not generate another encryption key. The admin private key must also be loaded from the existing ignored contracts env; the code checks its derived public address but never prints or exports it.

Set confirmation `B14_SEAL_MINT_CONFIRM=YES_SIGN_EXACT_TEUSD_MINT_DO_NOT_SEND` and add `--seal` to the preview command. It rechecks contract state, on-chain HBAR receipt, PostgreSQL journal, signer queue, nonce and fee quote under a signer-scoped PostgreSQL advisory lock. It locally signs the exact legacy chain-296 mint transaction; verifies full signed envelope and deterministic hash; encrypts the raw signed transaction with AES-256-GCM and the intent UUID as AAD; and atomically records `SIGNED`, nonce, hash, IV, tag and ciphertext. **There is no broadcast, no mint and no HBAR spending.** On success, immediately verify status with the existing journal-check command and stop until broadcast/reconciliation support is implemented.

If sealing fails, inspect the journal status. Never reset a journal row, re-sign, replace a nonce, rotate the encryption key, or manually broadcast the raw bytes to bypass a conflict.

## Safety notes

1. Exact B12 match and provenance, B07 wallet, canonical chain-296 contract metadata, token six-decimal units, MINTER_ROLE, zero TEUSD balance, HBAR funding confirmation and absence of trade all rechecked.
2. Required signer address is cryptographically derived from the private key and compared to the selected public minter; private key only read locally.
3. The mint intention is immutable and must match the existing `PLANNED` database row, with no earlier signed material.
4. Default mode performs no writes. The `--seal` mode **only** updates the existing journal row; no new intent, no blockchain broadcast.
5. Signer-scoped advisory lock and row lock prevent two cooperating B14 processes from using the same admin nonce. They do not coordinate with unrelated apps using the same key.
6. Gas hard limit 600,000; quoted maximum fee 0.75 Testnet HBAR; admin keeps >=1 HBAR reserve. If pricing exceeds the cap, stop and review manually—do not bypass the guard.
7. Signed transactions remain confidential but must be backed up alongside the AES key. For production, use proper key management/HSM and independent test coverage.
