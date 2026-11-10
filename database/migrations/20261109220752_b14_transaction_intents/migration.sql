-- CreateTable
CREATE TABLE "b14_transaction_intents" (
    "id" UUID NOT NULL,
    "match_id" UUID NOT NULL,
    "external_trade_id" CHAR(66) NOT NULL,
    "operation" VARCHAR(24) NOT NULL,
    "chain_id" INTEGER NOT NULL,
    "signer_address" VARCHAR(42) NOT NULL,
    "target_address" VARCHAR(42) NOT NULL,
    "payload_sha256" CHAR(64) NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'PLANNED',
    "nonce" VARCHAR(78),
    "tx_hash" VARCHAR(66),
    "signed_tx_ciphertext" TEXT,
    "signed_tx_iv" VARCHAR(24),
    "signed_tx_tag" VARCHAR(32),
    "last_error" TEXT,
    "confirmed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "b14_transaction_intents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "b14_transaction_intents_tx_hash_key" ON "b14_transaction_intents"("tx_hash");

-- CreateIndex
CREATE INDEX "b14_transaction_intents_status_idx" ON "b14_transaction_intents"("status");

-- CreateIndex
CREATE UNIQUE INDEX "b14_transaction_intents_match_id_operation_key" ON "b14_transaction_intents"("match_id", "operation");

-- AddForeignKey
ALTER TABLE "b14_transaction_intents" ADD CONSTRAINT "b14_transaction_intents_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
