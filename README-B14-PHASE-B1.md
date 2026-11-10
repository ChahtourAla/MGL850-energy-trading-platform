# B14 Phase B1 — Durable Transaction Journal Foundation (Additive)

B14 is NOT complete after this package. Scope is a schema migration and safety primitives for immutable, persistently recorded transaction intentions. No transaction signer, broadcaster, backend REST endpoint, or token funding is included. Do not claim a trade was created/funded.

**Base:** B14 Phase A already unpacked, and B13 commit `3fa4c89` before any B14 commit.

## Add this field to existing Match model in `database/schema.prisma`

```prisma
  b14TransactionIntents B14TransactionIntent[]
```

## Append this new model to `database/schema.prisma`

```prisma
model B14TransactionIntent {
  id                   String   @id @default(uuid()) @db.Uuid
  matchId              String   @map("match_id") @db.Uuid
  match                Match    @relation(fields: [matchId], references: [id], onDelete: Restrict)
  externalTradeId      String   @map("external_trade_id") @db.Char(66)
  operation            String   @db.VarChar(24)
  chainId              Int      @map("chain_id")
  signerAddress        String   @map("signer_address") @db.VarChar(42)
  targetAddress        String   @map("target_address") @db.VarChar(42)
  payloadSha256        String   @map("payload_sha256") @db.Char(64)
  status               String   @default("PLANNED") @db.VarChar(24)
  nonce                String?  @db.VarChar(78)
  txHash               String?  @unique @map("tx_hash") @db.VarChar(66)
  signedTxCiphertext   String?  @map("signed_tx_ciphertext") @db.Text
  signedTxIv           String?  @map("signed_tx_iv") @db.VarChar(24)
  signedTxTag          String?  @map("signed_tx_tag") @db.VarChar(32)
  lastError            String?  @map("last_error") @db.Text
  confirmedAt          DateTime? @map("confirmed_at") @db.Timestamptz(3)
  createdAt            DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt            DateTime @updatedAt @map("updated_at") @db.Timestamptz(3)

  @@unique([matchId, operation])
  @@index([status])
  @@map("b14_transaction_intents")
}
```

The unique `(match_id, operation)` key intentionally forbids a second mint/approval/create/fund intent for the same match, including after failed or uncertain attempts. Do not delete records to bypass this rule. A live transaction signing/writing engine must enforce transitions and signing/nonces atomically against the DB; the pure helper functions alone do not create a database concurrency lock.

## Installation and migration safety

Extract ZIP in repo root, after ensuring no B14 B1 files already exist. Run:

```powershell
node --test apps/backend/scripts/b14-intent-journal.test.mjs
pnpm exec prisma validate --config prisma7.config.ts
pnpm exec prisma migrate dev --config prisma7.config.ts --name b14_transaction_intents --create-only
```

**Inspect the generated migration.sql before applying.** It should create only the `b14_transaction_intents` table, the FK to matches, a unique `(match_id, operation)` index, a unique tx_hash index, a status index. Reject any changes to existing tables, destruction, reset or unrelated modifications. Then:

```powershell
pnpm exec prisma migrate dev --config prisma7.config.ts
pnpm exec prisma migrate status --config prisma7.config.ts
pnpm exec prisma generate --config prisma7.config.ts
pnpm --filter @energy-trading/backend build
pnpm --filter @energy-trading/backend typecheck
pnpm --filter @energy-trading/backend test
pnpm --filter @energy-trading/backend lint
```

After all succeed:

```powershell
Push-Location apps/backend
try {
 node --env-file=../../.env scripts/b14-intent-journal-check.mjs --match-id 60bd8ca9-bb7d-534f-8564-468e4a5f0b3a
 if ($LASTEXITCODE -ne 0) {throw 'Journal check failed'}
} finally { Pop-Location }
```

Expected: `B14 JOURNAL READY ...`, `B14 JOURNAL RECORDS: 0`, `B14 READ-ONLY PASS`.

Do not run the original contract smoke-test script; it uses different actors and creates synthetic trades. Don't commit root `.env`, wallet private keys or artifacts. Phase B2 must add a vetted database state machine with row-level locking, signing via B07 custodial wallet service, operator/admin secret isolation, encrypted raw signed tx journal persistence **before broadcast**, hash-based recovery, fee budget controls, and four authorized on-chain operations after buyer HBAR is funded. The B1 package itself deliberately cannot spend HBAR or TEUSD.
