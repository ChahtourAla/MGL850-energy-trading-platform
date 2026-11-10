# B14 Phase B3 — Secure operator HBAR sealing (no broadcast)

**Scope:** Implement optional signing and persistence of the already staged `FUND_BUYER_HBAR` transaction. Default mode is **read-only** preview, with `--seal` strictly separated behind `B14_SEAL_INTENT_CONFIRM=YES_SIGN_BUT_DO_NOT_SEND` and an encrypted-transaction key. There is **no** broadcast / fund / mint code in this package. The on-chain transfer is not part of this phase.

## Existing B14 testnet context

- Repository branch: feature/nestjs-backend; B13 commit `3fa4c89`.
- Match UUID `60bd8ca9-bb7d-534f-8564-468e4a5f0b3a`.
- B14 transaction intent UUID `38065271-3ca3-4e18-b3b0-1fce7fb853d6`; operation `FUND_BUYER_HBAR`, state `PLANNED`.
- B14 buyer 0x255d93780b72aeb3c29187765d900eae4cf67f31.
- Operator 0xD74a6786587A2a936cFb059fec998Ad6DB300F37; Testnet chain 296.
- Funding amount 0.2 HBAR (20,000,000 tinybars = 0.2 * 10^18 wei).
- No new Prisma migrations or dependencies, uses existing ethers 6, Prisma, B13 and B14 A/B1/B2 modules.

## Files to install from overlay

`apps/backend/scripts/b14-hbar-seal-core.mjs`, `b14-hbar-seal-core.test.mjs`, `b14-hbar-seal.mjs`.

## Offline verification

```powershell
node --test apps/backend/scripts/b14-hbar-seal-core.test.mjs
node --check apps/backend/scripts/b14-hbar-seal.mjs
pnpm --filter @energy-trading/backend build
pnpm --filter @energy-trading/backend typecheck
```

## Default preview (NO signing, NO DB changes, NO transfer)

```powershell
Push-Location apps/backend
try {
  node --env-file=../../.env --env-file=../../packages/contracts/.env scripts/b14-hbar-seal.mjs `
    --match-id '60bd8ca9-bb7d-534f-8564-468e4a5f0b3a' `
    --intent-id '38065271-3ca3-4e18-b3b0-1fce7fb853d6' `
    --operator-address '0xD74a6786587A2a936cFb059fec998Ad6DB300F37' `
    --hbar 0.2
  if ($LASTEXITCODE -ne 0) { throw 'B14 B3 signer preview failed' }
} finally { Pop-Location }
```

Important: the signer key must remain in existing ignored `packages/contracts/.env` and **must not** be copied into root `.env`, source code or user chat. The preview derives only the operator public address and performs RPC reads, nonce/fee checks, and journal validation.

## Optional later phase: seal, only after preview passes and operator reviews transaction

This action signs a transaction locally, encrypts it, and persists `status=SIGNED` with the nonce and hash, **without broadcasting**. It is not part of the first verification step. Never sign again if status `SIGNED`, `SUBMITTED`, or uncertain. Do not manually edit the journal or use a second nonce from the same operator.

To enable sealing securely, generate a stable random 32-byte AES key and save **only inside the ignored** `packages/contracts/.env`; avoid writing the key to the console/logs. Do not proceed until you have backed up this env securely. Suggested local-only PowerShell procedure (run once):

```powershell
$contractEnv = 'packages/contracts/.env'
git check-ignore -q $contractEnv
if ($LASTEXITCODE -ne 0) { throw 'Contracts env file is NOT git-ignored' }
if (Select-String -LiteralPath $contractEnv -Pattern '^B14_SIGNED_TX_KEY_B64=' -Quiet) {
  throw 'Journal encryption key exists; do not rotate or overwrite'
}
$key = node -p "require('node:crypto').randomBytes(32).toString('base64')"
Add-Content -LiteralPath $contractEnv -Value "B14_SIGNED_TX_KEY_B64=$key"
Remove-Variable key
```

Then pass `--seal` with explicit env confirmation set for that one command only:

```powershell
$env:B14_SEAL_INTENT_CONFIRM = 'YES_SIGN_BUT_DO_NOT_SEND'
Push-Location apps/backend
try {
 node --env-file=../../.env --env-file=../../packages/contracts/.env scripts/b14-hbar-seal.mjs `
   --match-id '60bd8ca9-bb7d-534f-8564-468e4a5f0b3a' `
   --intent-id '38065271-3ca3-4e18-b3b0-1fce7fb853d6' `
   --operator-address '0xD74a6786587A2a936cFb059fec998Ad6DB300F37' `
   --hbar 0.2 --seal
 if ($LASTEXITCODE -ne 0) { throw 'B14 B3 seal failed; inspect journal' }
} finally {
 Pop-Location
 Remove-Item Env:\B14_SEAL_INTENT_CONFIRM -ErrorAction SilentlyContinue
}
```

**No one should run this seal step until the preview and output are reviewed.** Later B14 Phase B4 will only broadcast exact persisted signed bytes; no re-sign/repricing on timeout. The encrypted signed transaction becomes invalid if the AES key is lost; treat it as a secret and back it up securely. Never print encryption keys or raw signed tx.

## Safety rules

- Compare exact selected B12 match against its B11 energy provenance and B07 wallets.
- Check canonical B13 deployment, Testnet chain 296, operator role, paused flag, and absence of an existing on-chain trade.
- Recompute the immutable 0.2 HBAR payload digest, compare with the already staged B14 journal, refuse other operations, status changes and duplicate entries.
- Fee estimator allows max 0.1 HBAR in potential gas fees, 250k gas limit, requires 1 HBAR operator reserve after amount/fees.
- Require `pendingNonce === latestNonce`; refuse if other local `SIGNED` / `SUBMITTED` / `NEEDS_RECONCILIATION` rows exist for the operator.
- Advisory transaction lock by `(chainId, signer)` and row-level lock on intent for a single signing session; lock does not coordinate with other systems that use operator key.
- Never print raw signed transaction/private key; encrypt raw signed bytes using AES-256-GCM + intent UUID AAD.
- `--seal` changes **only** existing journal row from PLANNED to SIGNED. No transfer and no broadcast in B3.
- This is a guarded development workflow, not a production-grade custodial signing service or HSM.
