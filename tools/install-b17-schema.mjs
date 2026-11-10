/** Non-destructive additive B17 Prisma schema patch. Never runs migrations or touches DB. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export function patchB17Schema(input){
 if(input.includes('model B17OperatorIntent {')){
  if(!input.includes('b17OperatorIntents'))throw new Error('B17 model exists but Match relation missing; repair explicitly');
  return input;
 }
 const matches=[...input.matchAll(/^model\s+Match\s*\{[\s\S]*?^\}/gm)];
 if(matches.length!==1||input.includes('b17OperatorIntents'))throw new Error('Cannot safely locate a unique Match model');
 const relation='  b17OperatorIntents B17OperatorIntent[]\n';
 const model=`\n// B17 operator intent journal (distinct from B14 funding and B16 oracle journal).
model B17OperatorIntent {
  id                 String    @id @default(uuid()) @db.Uuid
  matchId            String    @map("match_id") @db.Uuid
  match              Match     @relation(fields: [matchId], references: [id], onDelete: Restrict)
  operation          String    @db.VarChar(12)
  externalTradeId    String    @map("external_trade_id") @db.Char(66)
  onChainTradeId     String    @map("on_chain_trade_id") @db.VarChar(78)
  chainId            Int       @default(296) @map("chain_id")
  signerAddress      String    @map("signer_address") @db.VarChar(42)
  targetAddress      String    @map("target_address") @db.VarChar(42)
  buyerAddress       String    @map("buyer_address") @db.VarChar(42)
  totalAmountMicrousd String   @map("total_amount_microusd") @db.VarChar(78)
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

  @@unique([matchId, operation])
  @@index([status])
  @@map("b17_operator_intents")
}
`;
 const m=matches[0];
 return (input.slice(0,m.index)+m[0].replace(/\}\s*$/,`${relation}}`)+input.slice(m.index+m[0].length)).trimEnd()+'\n'+model;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const file=resolve('database/schema.prisma');const old=readFileSync(file,'utf8'),next=patchB17Schema(old);
 if(next!==old)writeFileSync(file,next,'utf8');
 console.log(next===old?'B17 schema already installed':'B17 schema model added; no database mutation');
}
