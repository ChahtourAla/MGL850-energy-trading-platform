# B14 Phase B2 — Buyer HBAR Funding Intent (not a transaction)

**Purpose:** Compute and optionally persist the first immutable transaction intent for the selected B12 buyer. It uses the B14 Phase A validated B12 match, B13 read-only Hedera contract gateway, and B14 Phase B1 PostgreSQL journal. It never decrypts custodial keys, signs anything, broadcasts, transfers HBAR, mints TEUSD, approves a spender, creates a trade, or funds escrow. Phase B14 is NOT complete.

**Previously validated:** `matchId=60bd8ca9-bb7d-534f-8564-468e4a5f0b3a`; operator `0xD74a6786587A2a936cFb059fec998Ad6DB300F37` has OPERATOR_ROLE, buyer has zero HBAR, admin has MINTER_ROLE. These are observations from earlier tests; re-check chain state before staging.

## Installation

At project root, ensure Phase A/B1 and Prisma migration already exist. Extract `B14-phase-B2-buyer-HBAR-intent.zip` only if `apps/backend/scripts/b14-buyer-hbar-plan.mjs` is absent.

Run:

```powershell
node --test apps/backend/scripts/b14-buyer-hbar-core.test.mjs
node --check apps/backend/scripts/b14-buyer-hbar-plan.mjs
pnpm --filter @energy-trading/backend build
pnpm --filter @energy-trading/backend typecheck
```

Expect 37/37 new safety tests.

## Read-only preview

From project root, with actual `.env` values securely stored:

```powershell
Push-Location apps/backend
try {
  node --env-file=../../.env scripts/b14-buyer-hbar-plan.mjs `
    --match-id '60bd8ca9-bb7d-534f-8564-468e4a5f0b3a' `
    --operator-address '0xD74a6786587A2a936cFb059fec998Ad6DB300F37' `
    --hbar 0.2
  if ($LASTEXITCODE -ne 0) { throw 'B14 B2 preview failed' }
} finally { Pop-Location }
```

This previews exactly **0.2 HBAR** transferred from the verified public operator EVM address to the B07 custodial buyer EVM address. It bounds the amount to 0.1–1 HBAR, refuses when buyer already holds >=0.05 HBAR or operator balance is too low, and refuses when a trade already exists. The amount is a chosen prototype testnet fee reserve, not a fee prediction or automatic transfer approval.

## Stage immutable intent (DB write, no HBAR spending)

**Only after reviewing preview** and accepting 0.2 HBAR as future testnet transfer amount:

```powershell
$env:B14_STAGE_INTENT_CONFIRM = 'YES'
Push-Location apps/backend
try {
  node --env-file=../../.env scripts/b14-buyer-hbar-plan.mjs `
    --match-id '60bd8ca9-bb7d-534f-8564-468e4a5f0b3a' `
    --operator-address '0xD74a6786587A2a936cFb059fec998Ad6DB300F37' `
    --hbar 0.2 --stage
  if ($LASTEXITCODE -ne 0) { throw 'B14 B2 staging failed' }
} finally {
  Pop-Location
  Remove-Item Env:\B14_STAGE_INTENT_CONFIRM -ErrorAction SilentlyContinue
}
```

Should produce `B14 B2 STAGED: CREATED intent=... status=PLANNED ...`. A second identical `--stage` should report `UNCHANGED`, not create another record. **Do not stage a different amount, change the target, or delete the row to retry**. Any existing SIGNED/SUBMITTED/NEEDS_RECONCILIATION state must be reconciled first.

Then use the existing B14 journal verifier to show one `PLANNED` row.

## Required next phase

This package does not implement the actual transfer. Before broadcasting, implement: designated nonce ownership; a database-protected signer/nonce reservation; a signer that matches the stored public address; network fee budget and gas estimator; local transaction signing; AES-256-GCM of the raw signed bytes; an atomic `PLANNED→SIGNED` update that persists nonce/hash/encrypted raw signed transaction **before** network broadcast; a hash-based reconciliation flow; and explicit per-transaction operator approval. No password/key material should be supplied to the CLI, logs or Git.

The transaction journal unique index `(matchId, operation)` prevents a second intent for the same operation, but by itself does not lock signing across separate processes. An encrypted journal entry should not be considered recoverable unless its encryption key is separately backed up securely.

Do not run the existing contracts smoke-test script; it operates with unrelated smoke accounts and creates real transactions.
