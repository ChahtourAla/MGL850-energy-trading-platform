-- B17 independent operator recovery journal. Additive; never modifies B14 or B16 intents.
CREATE TABLE "b17_operator_intents" (
  "id" UUID NOT NULL,
  "match_id" UUID NOT NULL,
  "operation" VARCHAR(12) NOT NULL,
  "external_trade_id" CHAR(66) NOT NULL,
  "on_chain_trade_id" VARCHAR(78) NOT NULL,
  "chain_id" INTEGER NOT NULL DEFAULT 296,
  "signer_address" VARCHAR(42) NOT NULL,
  "target_address" VARCHAR(42) NOT NULL,
  "buyer_address" VARCHAR(42) NOT NULL,
  "total_amount_microusd" VARCHAR(78) NOT NULL,
  "call_data_sha256" CHAR(64) NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'PLANNED',
  "nonce" VARCHAR(78),
  "tx_hash" VARCHAR(66),
  "signed_tx_ciphertext" TEXT,
  "signed_tx_iv" VARCHAR(24),
  "signed_tx_tag" VARCHAR(32),
  "last_error" TEXT,
  "confirmed_at" TIMESTAMPTZ(3),
  "synced_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "b17_operator_intents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "b17_operator_intents_operation_check" CHECK ("operation" IN ('CANCEL','EXPIRE','REFUND')),
  CONSTRAINT "b17_operator_intents_status_check" CHECK ("status" IN ('PLANNED','SIGNED','SUBMITTED','NEEDS_RECONCILIATION','CONFIRMED','REVERTED'))
);
CREATE UNIQUE INDEX "b17_operator_intents_match_id_operation_key" ON "b17_operator_intents"("match_id", "operation");
CREATE UNIQUE INDEX "b17_operator_intents_tx_hash_key" ON "b17_operator_intents"("tx_hash");
CREATE INDEX "b17_operator_intents_status_idx" ON "b17_operator_intents"("status");
ALTER TABLE "b17_operator_intents" ADD CONSTRAINT "b17_operator_intents_match_id_fkey"
  FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
