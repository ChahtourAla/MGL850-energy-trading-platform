# B14 Phase B5-C — One-shot TestEnergyUSD mint broadcast and receipt recovery

This overlay adds **three new JavaScript files** and this README. It does not overwrite B13, B14 B1–B5B, Prisma migrations, the signed `MINT_TEUSD` journal, or any `.env` file. No dependencies are added.

## Existing transaction that MUST be reused

- B12 match: `60bd8ca9-bb7d-534f-8564-468e4a5f0b3a`
- Existing MINT_TEUSD intent: `a6ded8be-45b8-4833-99c0-fc9e93771cff`
- Journal status after B5-B: **SIGNED**
- Stored mint hash: `0xb1aba96c4ab35f27f04137590201b3aeccf790f1201d4173f25546fd192a9800`
- Minter/admin: `0x30f98bBDCD8A334B0b382c0Ba521EECDb23592D4`
- Buyer: `0x255d93780b72aeb3c29187765d900eae4cf67f31`
- Token: `0x9Ada96be34382a1554C0bE4Fb35cC010C05A5C7c`
- Exact token amount: 250232 base units = 0.250232 TEUSD
- Signed admin nonce: **3**
- Previous HBAR funding intent is **CONFIRMED**. Do not create another.

The existing `B14_SIGNED_TX_KEY_B64` (git-ignored `packages/contracts/.env`) must remain unchanged. B5-C **never reads a signing private key**; it decrypts and verifies the previously signed transaction locally before any possible broadcast.

## File list

- `apps/backend/scripts/b14-teusd-mint-broadcast-core.mjs`
- `apps/backend/scripts/b14-teusd-mint-broadcast-core.test.mjs`
- `apps/backend/scripts/b14-teusd-mint-broadcast.mjs`

## Tests (from repository root)

```powershell
node --test apps/backend/scripts/b14-teusd-mint-broadcast-core.test.mjs
node --check apps/backend/scripts/b14-teusd-mint-broadcast.mjs
pnpm --filter @energy-trading/backend build
pnpm --filter @energy-trading/backend typecheck
pnpm --filter @energy-trading/backend test
pnpm --filter @energy-trading/backend lint
```

## FIRST RUN: live preview ONLY (no database mutation or Hedera transaction)

Run from repository root:

```powershell
Push-Location apps/backend
try {
    node --env-file=../../.env --env-file=../../packages/contracts/.env scripts/b14-teusd-mint-broadcast.mjs --match-id "60bd8ca9-bb7d-534f-8564-468e4a5f0b3a" --intent-id "a6ded8be-45b8-4833-99c0-fc9e93771cff" --admin-address "0x30f98bBDCD8A334B0b382c0Ba521EECDb23592D4"
    if ($LASTEXITCODE -ne 0) { throw 'B14 B5-C preview failed. Stop.' }
} finally { Pop-Location }
```

Expected `journalStatus: "SIGNED"`, stored hash, `storedNonce: "3"`, `buyerTeusdUnits: "0"`, `chainState: "ABSENT_AT_RPC"` **only if the transaction has not been broadcast externally**. In that case `action: "PREVIEW"` and `B14 B5-C PREVIEW PASS` should appear.

Do not submit if the nonce differs, transaction is seen pending, receipt is visible or state is unknown. A null receipt does **not** prove that sending is safe. Send the preview output to be independently reviewed before further actions.

## Later, only with explicit user approval: one-shot submit

This sends the existing stored signed `mint(buyer,250232)` transaction once; it can incur a Hedera Testnet gas fee from the admin. It **does not sign a new transaction**. It atomically persists `SIGNED -> SUBMITTED` *before* calling `eth_sendRawTransaction`. The only way to recover an ambiguous result is hash-based reconciliation; there is **no automatic retry**.

```powershell
$env:B14_BROADCAST_MINT_CONFIRM = 'SEND_EXACT_SIGNED_250232_TEUSD_MINT'
Push-Location apps/backend
try {
    node --env-file=../../.env --env-file=../../packages/contracts/.env scripts/b14-teusd-mint-broadcast.mjs --match-id "60bd8ca9-bb7d-534f-8564-468e4a5f0b3a" --intent-id "a6ded8be-45b8-4833-99c0-fc9e93771cff" --admin-address "0x30f98bBDCD8A334B0b382c0Ba521EECDb23592D4" --submit
    if ($LASTEXITCODE -ne 0) { throw 'B14 mint outcome uncertain: DO NOT retry --submit' }
} finally { Pop-Location; Remove-Item Env:\B14_BROADCAST_MINT_CONFIRM -ErrorAction SilentlyContinue }
```

## Later: receipt-only reconciliation (never re-broadcasts)

```powershell
$env:B14_RECONCILE_MINT_CONFIRM = 'RECONCILE_EXISTING_MINT_HASH_ONLY'
Push-Location apps/backend
try {
    node --env-file=../../.env --env-file=../../packages/contracts/.env scripts/b14-teusd-mint-broadcast.mjs --match-id "60bd8ca9-bb7d-534f-8564-468e4a5f0b3a" --intent-id "a6ded8be-45b8-4833-99c0-fc9e93771cff" --admin-address "0x30f98bBDCD8A334B0b382c0Ba521EECDb23592D4" --reconcile
    if ($LASTEXITCODE -ne 0) { throw 'B14 mint reconciliation failed' }
} finally { Pop-Location; Remove-Item Env:\B14_RECONCILE_MINT_CONFIRM -ErrorAction SilentlyContinue }
```

If the receipt is successful, the code requires a token `Transfer` event **from the zero address to the exact buyer for 250232 units**, plus a live buyer token balance of **exactly 250232**. Only then does it commit `CONFIRMED`. Receipt status 0 maps to `REVERTED`; pending/ambiguous results do not become successful and **never trigger a second submission**.

For journal verification (read-only):

```powershell
Push-Location apps/backend
try {
    node --env-file=../../.env scripts/b14-intent-journal-check.mjs --match-id "60bd8ca9-bb7d-534f-8564-468e4a5f0b3a"
} finally { Pop-Location }
```

## Safety limitations

- Prototype is for **Hedera Testnet only**, chain 296, with a pre-approved single test-token mint. Never apply it to mainnet unchanged.
- PostgreSQL signer-scoped advisory locks coordinate only cooperating B14 processes. Other apps using the admin key are NOT controlled; pause those apps until reconciliation completes.
- A receipt may be temporarily absent from the relay. Never use a missing receipt to justify re-broadcasting or signing a replacement.
- Reconciliation depends on available historical B12 match and prior HBAR journal data; archive these.
- Exact buyer balance equality is intentional: any unrelated token movement after mint causes a manual review instead of silently declaring success.
- This is not a production-grade generalized payment executor, audited custody/HSM implementation, or complete decentralized trade lifecycle.
