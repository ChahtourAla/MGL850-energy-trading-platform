# B14 Phase B4 — One-shot Hedera Testnet broadcast + journal recovery

**Adds** a read-only preview, an explicit single-send mode, and a hash-only reconciliation mode for the already sealed 0.2 HBAR buyer top-up. It **never signs**, **never creates journal rows**, **never changes the transfer amount**, **never mints tokens**, **never calls escrow contracts** and **never retries broadcasts automatically**.

## Existing journal that MUST be reused

- Match: `60bd8ca9-bb7d-534f-8564-468e4a5f0b3a`
- Intent: `38065271-3ca3-4e18-b3b0-1fce7fb853d6`
- State at B4 entry: `SIGNED`
- Stored immutable hash: `0xebde77004e98b296dab6be9826136fdc25e832799b7c5047ef8c719f5dc18750`
- Nonce `3`, signer `0xD74a6786587A2a936cFb059fec998Ad6DB300F37`, buyer `0x255d93780b72aeb3c29187765d900eae4cf67f31`
- Value: **exactly 0.2 Testnet HBAR**
- The existing `B14_SIGNED_TX_KEY_B64` in the ignored contracts `.env` is required to decrypt. **Do not rotate or display it.**

## Files in this overlay

- `apps/backend/scripts/b14-hbar-broadcast-core.mjs` — pure guards, hash/receipt validation, reconciliation state machine.
- `apps/backend/scripts/b14-hbar-broadcast-core.test.mjs` — tests.
- `apps/backend/scripts/b14-hbar-broadcast.mjs` — preview, guarded claim/broadcast and receipt reconciliation CLI.

No dependency changes, schema changes or migrations. Existing B14 B1/B2/B3 files remain untouched.

## Offline tests

```powershell
cd C:\Users\AV11150\Desktop\MGL850\p2p-energy-trading-platform
node --test apps/backend/scripts/b14-hbar-broadcast-core.test.mjs
node --check apps/backend/scripts/b14-hbar-broadcast.mjs
pnpm --filter @energy-trading/backend build
pnpm --filter @energy-trading/backend typecheck
pnpm --filter @energy-trading/backend test
pnpm --filter @energy-trading/backend lint
```

## Read-only live preview — FIRST RUN ONLY

Execute in `apps/backend` (the following is **one line** to avoid PowerShell line-continuation errors):

```powershell
Push-Location apps/backend
try {
  node --env-file=../../.env --env-file=../../packages/contracts/.env scripts/b14-hbar-broadcast.mjs --match-id "60bd8ca9-bb7d-534f-8564-468e4a5f0b3a" --intent-id "38065271-3ca3-4e18-b3b0-1fce7fb853d6" --operator-address "0xD74a6786587A2a936cFb059fec998Ad6DB300F37" --hbar 0.2
  if ($LASTEXITCODE -ne 0) { throw 'B14 B4 preview failed' }
} finally { Pop-Location }
```

The output should show `action: "PREVIEW"`, `journalStatus: "SIGNED"`, stored hash and nonce, and `chainState: "ABSENT_AT_RPC"` before any submit. If the chain returns `PENDING_OR_INDEXING`, `CONFIRMED`, `REVERTED`, or `NONCE_MISMATCH_UNKNOWN`, **do not submit**. Reconcile or investigate.

## Explicit submit — DO NOT RUN until reviewed and approved

Submitting spends **0.2 Testnet HBAR plus network fees**. The process sets `SUBMITTED` **before** the RPC call. A crash after the claim can leave `SUBMITTED` without a known on-chain receipt. **Never rerun `--submit`** in that case; reconciliation is mandatory, and no automatic replay is provided.

```powershell
$env:B14_BROADCAST_CONFIRM = 'SEND_EXACT_SIGNED_0_2_TESTNET_HBAR'
Push-Location apps/backend
try {
  node --env-file=../../.env --env-file=../../packages/contracts/.env scripts/b14-hbar-broadcast.mjs --match-id "60bd8ca9-bb7d-534f-8564-468e4a5f0b3a" --intent-id "38065271-3ca3-4e18-b3b0-1fce7fb853d6" --operator-address "0xD74a6786587A2a936cFb059fec998Ad6DB300F37" --hbar 0.2 --submit
  if ($LASTEXITCODE -ne 0) { throw 'B14 broadcast uncertain; reconcile exact stored hash; DO NOT retry submit' }
} finally { Pop-Location; Remove-Item Env:\B14_BROADCAST_CONFIRM -ErrorAction SilentlyContinue }
```

## Explicit reconcile — never resends transaction

```powershell
$env:B14_RECONCILE_CONFIRM='RECONCILE_EXISTING_HASH_ONLY'
Push-Location apps/backend
try {
  node --env-file=../../.env --env-file=../../packages/contracts/.env scripts/b14-hbar-broadcast.mjs --match-id "60bd8ca9-bb7d-534f-8564-468e4a5f0b3a" --intent-id "38065271-3ca3-4e18-b3b0-1fce7fb853d6" --operator-address "0xD74a6786587A2a936cFb059fec998Ad6DB300F37" --hbar 0.2 --reconcile
  if ($LASTEXITCODE -ne 0) { throw 'B14 reconciliation failed' }
} finally { Pop-Location; Remove-Item Env:\B14_RECONCILE_CONFIRM -ErrorAction SilentlyContinue }
```

Then check the journal:

```powershell
Push-Location apps/backend
try { node --env-file=../../.env scripts/b14-intent-journal-check.mjs --match-id "60bd8ca9-bb7d-534f-8564-468e4a5f0b3a" } finally { Pop-Location }
```

- A matching successful receipt produces `CONFIRMED` and `confirmedAt`.
- A matching reverted receipt produces `REVERTED`.
- A visible transaction without receipt produces `SUBMITTED` (not success).
- Missing receipt and transaction with a claimed journal may become `NEEDS_RECONCILIATION`; never treat this as safe-to-resend.

## Safeguards and limitations

- Exact B12 match, B07 buyer, canonical B13 deployment, chain ID 296, fixed amount, immutable journal digest, signed hash, signer, nonce, gas ceiling, buyer target and calldata validated.
- `--submit` requires **an exact consent variable** and refuses if operator nonce changed, buyer balance already >=0.05 HBAR, escrow paused, operator role revoked, any local/on-chain trade exists, or another local unresolved signer intent exists.
- The PostgreSQL advisory lock and row-level lock protect B14 application concurrency. They cannot coordinate with *external* signers using the same operator key. Pause external signing until B4 concludes.
- `eth_sendRawTransaction` is called once **only after** an atomic persisted `SIGNED -> SUBMITTED` claim. Errors move it into `NEEDS_RECONCILIATION`; raw bytes are never logged.
- Hedera JSON-RPC receipt indexing may lag. A null `eth_getTransactionReceipt` is not proof a transfer failed or can be resubmitted. See Hiero JSON-RPC relay debugging documentation.
- `--reconcile` never sends transactions and can operate even after the escrow becomes paused or the role is removed. However, it still requires historical B12 and wallet data to be present.
- This is a prototype CLI workflow, not a production-grade generalized payment orchestration, HSM, key rotation or operator queue service.

**Implementation process:** Install, run tests, run read-only preview, and share output. Do not execute `--submit` until the live preview has been independently reviewed.
