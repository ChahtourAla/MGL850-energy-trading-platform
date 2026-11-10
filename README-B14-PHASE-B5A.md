# B14 Phase B5-A: Exact TestEnergyUSD mint intention

Additive, read-only-by-default overlay for the existing B14 branch.

## What this implementation does

- Loads the committed B12 `Match`, `MatchingRun`, original B11 energy records and verified B07 wallet mapping.
- Independently validates the previously confirmed 0.2 Testnet HBAR transfer in the database AND its original Hedera transaction and receipt.
- Reads TestEnergyUSD's actual `MINTER_ROLE`, decimals, symbol, buyer balance, admin HBAR balance, buyer HBAR balance and existing on-chain trade ID.
- Derives the exact 0.250232 TEUSD payment (250232 six-decimal units) from the trusted B12 match.
- Uses the canonical shared token ABI for `mint(address,uint256)`, checks encoded call data, pins destination to the existing matched buyer and token address, and fingerprints the immutable action in the B14 transaction journal.
- `PREVIEW` (default): no database changes and no Testnet transactions.
- `--stage`: requires `B14_STAGE_MINT_CONFIRM=STAGE_EXACT_TEUSD_MINT_NO_TX`; stores only the exact `PLANNED` journal record. Does not sign, mint, broadcast, approve tokens or transfer HBAR.
- Existing matching `PLANNED` mint intents may be rechecked; a differently planned or already signed mint intent is never replaced.

## Files

- `apps/backend/scripts/b14-teusd-mint-core.mjs`
- `apps/backend/scripts/b14-teusd-mint-core.test.mjs`
- `apps/backend/scripts/b14-teusd-mint-plan.mjs`

No Prisma migration, no Node package changes, no wallet key handling, no edits to previous B14 scripts.

## Offline tests

```powershell
node --test apps/backend/scripts/b14-teusd-mint-core.test.mjs
node --check apps/backend/scripts/b14-teusd-mint-plan.mjs
pnpm --filter @energy-trading/backend build
pnpm --filter @energy-trading/backend typecheck
```

## Live preview (read-only)

```powershell
Push-Location apps/backend
try {
  node --env-file=../../.env scripts/b14-teusd-mint-plan.mjs --match-id "60bd8ca9-bb7d-534f-8564-468e4a5f0b3a" --admin-address "0x30f98bBDCD8A334B0b382c0Ba521EECDb23592D4"
  if ($LASTEXITCODE -ne 0) { throw "B14 B5 mint preview failed" }
} finally { Pop-Location }
```

Expected: `B14 B5 PREVIEW PASS`, `mintUnits: "250232"`, `mintTeusd: "0.250232"`, `buyerTeusdUnits: "0"`, `hbarJournalStatus: "CONFIRMED"`, `adminHasMinterRole: true`, `journal: "CREATE"` and `databaseWriteRequested: false`. The network values are read live and may change.

Do NOT add `--stage` without first reviewing the preview output. The later mint signer and broadcaster must separately verify the live balance, role, original journal payload, nonce, gas, and original encoded calldata before submitting anything.
