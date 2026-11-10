/** Additive idempotent schema patch. No database connection; never overwrites other models. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const path=resolve('database/schema.prisma');let schema=readFileSync(path,'utf8');
if (schema.includes('model B16OracleIntent {')) {
 console.log('B16 Prisma model already present; no change');process.exit(0);
}
const match=schema.match(/(^model\s+Match\s*\{)([\s\S]*?)(^\})/m);
if(!match||schema.includes('b16OracleIntent'))throw new Error('Could not safely locate unique Match model or B16 relation');
const insert='\n  b16OracleIntent B16OracleIntent?\n';
const model=`
// B16 oracle action is separate from B14 transaction intent journal.
model B16OracleIntent {
  id                 String    @id @default(uuid()) @db.Uuid
  matchId            String    @unique @map("match_id") @db.Uuid
  match              Match     @relation(fields: [matchId], references: [id], onDelete: Restrict)
  tradeId            String    @map("trade_id") @db.Uuid
  onChainTradeId     String    @map("on_chain_trade_id") @db.VarChar(78)
  deliveryId         String    @map("delivery_id") @db.Uuid
  evidencePayload    Json      @map("evidence_payload")
  evidenceHash       String    @map("evidence_hash") @db.Char(66)
  signerAddress      String    @map("signer_address") @db.VarChar(42)
  targetAddress      String    @map("target_address") @db.VarChar(42)
  callDataSha256     String    @map("call_data_sha256") @db.Char(64)
  status             String    @default("PLANNED") @db.VarChar(24)
  nonce              String?   @db.VarChar(78)
  txHash             String?   @unique @map("tx_hash") @db.VarChar(66)
  signedTxCiphertext String?   @map("signed_tx_ciphertext") @db.Text
  signedTxIv         String?   @map("signed_tx_iv") @db.VarChar(24)
  signedTxTag        String?   @map("signed_tx_tag") @db.VarChar(32)
  lastError          String?   @map("last_error") @db.Text
  confirmedAt        DateTime? @map("confirmed_at") @db.Timestamptz(3)
  syncedAt           DateTime? @map("synced_at") @db.Timestamptz(3)
  createdAt          DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt          DateTime  @updatedAt @map("updated_at") @db.Timestamptz(3)

  @@index([status])
  @@map("b16_oracle_intents")
}
`;
schema=schema.replace(match[0],match[1]+insert+match[2]+match[3]);
schema=schema.trimEnd()+'\n'+model;
writeFileSync(path,schema,'utf8');console.log('B16 Prisma model and Match relation added (no database mutation)');
