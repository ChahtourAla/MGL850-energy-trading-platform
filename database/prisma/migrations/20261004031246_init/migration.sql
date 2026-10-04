-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "physical_address" TEXT,
    "x_km" DECIMAL(10,4),
    "y_km" DECIMAL(10,4),
    "preferred_energy_type" VARCHAR(50),
    "reputation" SMALLINT NOT NULL DEFAULT 100,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallets" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "hedera_account_id" VARCHAR(50) NOT NULL,
    "evm_address" VARCHAR(42) NOT NULL,
    "public_key" TEXT NOT NULL,
    "encrypted_private_key" TEXT NOT NULL,
    "encryption_iv" TEXT NOT NULL,
    "encryption_auth_tag" TEXT NOT NULL,
    "key_version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "energy_records" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "time_slot" TIMESTAMPTZ NOT NULL,
    "production_wh" BIGINT NOT NULL,
    "consumption_wh" BIGINT NOT NULL,
    "net_energy_wh" BIGINT NOT NULL,
    "market_role" VARCHAR(20) NOT NULL,
    "available_energy_wh" BIGINT,
    "required_energy_wh" BIGINT,
    "energy_type" VARCHAR(50),
    "ask_price_microusd_per_kwh" BIGINT,
    "max_price_microusd_per_kwh" BIGINT,

    CONSTRAINT "energy_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "matches" (
    "id" UUID NOT NULL,
    "time_slot" TIMESTAMPTZ NOT NULL,
    "buyer_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "quantity_wh" BIGINT NOT NULL,
    "unit_price_microusd_per_kwh" BIGINT NOT NULL,
    "total_amount_microusd" BIGINT NOT NULL,
    "distance_km" DECIMAL(10,4) NOT NULL,
    "score" DECIMAL(5,4) NOT NULL,
    "seller_energy_type" VARCHAR(50) NOT NULL,
    "algorithm_version" VARCHAR(20) NOT NULL,
    "status" VARCHAR(30) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trades" (
    "id" UUID NOT NULL,
    "match_id" UUID NOT NULL,
    "on_chain_trade_id" BIGINT,
    "buyer_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "quantity_wh" BIGINT NOT NULL,
    "unit_price_microusd_per_kwh" BIGINT NOT NULL,
    "total_amount_microusd" BIGINT NOT NULL,
    "delivery_start" TIMESTAMPTZ NOT NULL,
    "delivery_deadline" TIMESTAMPTZ NOT NULL,
    "status" VARCHAR(30) NOT NULL,
    "contract_address" VARCHAR(42),
    "create_tx_id" VARCHAR(100),
    "fund_tx_id" VARCHAR(100),
    "confirm_tx_id" VARCHAR(100),
    "settlement_tx_id" VARCHAR(100),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_records" (
    "id" UUID NOT NULL,
    "trade_id" UUID NOT NULL,
    "buyer_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "expected_wh" BIGINT NOT NULL,
    "delivered_wh" BIGINT NOT NULL,
    "time_slot" TIMESTAMPTZ NOT NULL,
    "status" VARCHAR(30) NOT NULL,
    "evidence_hash" VARCHAR(66),
    "oracle_tx_id" VARCHAR(100),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blockchain_transactions" (
    "id" UUID NOT NULL,
    "trade_id" UUID,
    "operation" VARCHAR(50) NOT NULL,
    "hedera_transaction_id" VARCHAR(100),
    "transaction_hash" VARCHAR(66),
    "status" VARCHAR(30) NOT NULL,
    "network_fee_tinybar" BIGINT,
    "error_code" VARCHAR(100),
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMPTZ,

    CONSTRAINT "blockchain_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_user_id_key" ON "wallets"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_hedera_account_id_key" ON "wallets"("hedera_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_evm_address_key" ON "wallets"("evm_address");

-- CreateIndex
CREATE INDEX "energy_records_time_slot_market_role_idx" ON "energy_records"("time_slot", "market_role");

-- CreateIndex
CREATE UNIQUE INDEX "energy_records_user_id_time_slot_key" ON "energy_records"("user_id", "time_slot");

-- CreateIndex
CREATE INDEX "matches_time_slot_buyer_id_seller_id_idx" ON "matches"("time_slot", "buyer_id", "seller_id");

-- CreateIndex
CREATE UNIQUE INDEX "trades_match_id_key" ON "trades"("match_id");

-- CreateIndex
CREATE UNIQUE INDEX "trades_on_chain_trade_id_key" ON "trades"("on_chain_trade_id");

-- CreateIndex
CREATE INDEX "trades_buyer_id_seller_id_status_idx" ON "trades"("buyer_id", "seller_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_records_trade_id_time_slot_key" ON "delivery_records"("trade_id", "time_slot");

-- CreateIndex
CREATE INDEX "blockchain_transactions_hedera_transaction_id_idx" ON "blockchain_transactions"("hedera_transaction_id");

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "energy_records" ADD CONSTRAINT "energy_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_buyer_id_fkey" FOREIGN KEY ("buyer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_buyer_id_fkey" FOREIGN KEY ("buyer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_records" ADD CONSTRAINT "delivery_records_trade_id_fkey" FOREIGN KEY ("trade_id") REFERENCES "trades"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_records" ADD CONSTRAINT "delivery_records_buyer_id_fkey" FOREIGN KEY ("buyer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_records" ADD CONSTRAINT "delivery_records_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blockchain_transactions" ADD CONSTRAINT "blockchain_transactions_trade_id_fkey" FOREIGN KEY ("trade_id") REFERENCES "trades"("id") ON DELETE SET NULL ON UPDATE CASCADE;
