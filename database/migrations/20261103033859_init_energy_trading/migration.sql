-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "physical_address" TEXT,
    "x_km" DECIMAL(18,8),
    "y_km" DECIMAL(18,8),
    "preferred_energy_type" VARCHAR(16),
    "reputation" SMALLINT NOT NULL DEFAULT 50,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallets" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "hedera_account_id" VARCHAR(64) NOT NULL,
    "evm_address" VARCHAR(42) NOT NULL,
    "public_key" TEXT NOT NULL,
    "encrypted_private_key" TEXT NOT NULL,
    "encryption_iv" TEXT NOT NULL,
    "encryption_auth_tag" TEXT NOT NULL,
    "key_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "energy_records" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "time_slot" TIMESTAMPTZ(3) NOT NULL,
    "production_wh" BIGINT NOT NULL,
    "consumption_wh" BIGINT NOT NULL,
    "net_energy_wh" BIGINT NOT NULL,
    "market_role" VARCHAR(16) NOT NULL,
    "available_energy_wh" BIGINT,
    "required_energy_wh" BIGINT,
    "energy_type" VARCHAR(16),
    "ask_price_microusd_per_kwh" BIGINT,
    "max_price_microusd_per_kwh" BIGINT,

    CONSTRAINT "energy_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "matches" (
    "id" UUID NOT NULL,
    "time_slot" TIMESTAMPTZ(3) NOT NULL,
    "buyer_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "quantity_wh" BIGINT NOT NULL,
    "unit_price_microusd_per_kwh" BIGINT NOT NULL,
    "total_amount_microusd" BIGINT NOT NULL,
    "distance_km" DECIMAL(20,12) NOT NULL,
    "score" DECIMAL(20,12) NOT NULL,
    "seller_energy_type" VARCHAR(16) NOT NULL,
    "algorithm_version" VARCHAR(64) NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'SELECTED',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trades" (
    "id" UUID NOT NULL,
    "match_id" UUID NOT NULL,
    "external_trade_id" VARCHAR(66) NOT NULL,
    "on_chain_trade_id" BIGINT,
    "buyer_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "quantity_wh" BIGINT NOT NULL,
    "unit_price_microusd_per_kwh" BIGINT NOT NULL,
    "total_amount_microusd" BIGINT NOT NULL,
    "delivery_start" TIMESTAMPTZ(3) NOT NULL,
    "delivery_deadline" TIMESTAMPTZ(3) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'CREATED',
    "contract_address" VARCHAR(42),
    "create_tx_id" VARCHAR(128),
    "fund_tx_id" VARCHAR(128),
    "confirm_tx_id" VARCHAR(128),
    "settlement_tx_id" VARCHAR(128),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_records" (
    "id" UUID NOT NULL,
    "trade_id" UUID NOT NULL,
    "expected_wh" BIGINT NOT NULL,
    "delivered_wh" BIGINT NOT NULL,
    "time_slot" TIMESTAMPTZ(3) NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'PENDING',
    "evidence_hash" VARCHAR(66),
    "oracle_tx_id" VARCHAR(128),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blockchain_transactions" (
    "id" UUID NOT NULL,
    "trade_id" UUID,
    "operation" VARCHAR(64) NOT NULL,
    "hedera_transaction_id" VARCHAR(128),
    "transaction_hash" VARCHAR(128),
    "status" VARCHAR(32) NOT NULL,
    "network_fee_tinybar" BIGINT,
    "error_code" VARCHAR(128),
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMPTZ(3),

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
CREATE INDEX "matches_time_slot_idx" ON "matches"("time_slot");

-- CreateIndex
CREATE INDEX "matches_buyer_id_time_slot_idx" ON "matches"("buyer_id", "time_slot");

-- CreateIndex
CREATE INDEX "matches_seller_id_time_slot_idx" ON "matches"("seller_id", "time_slot");

-- CreateIndex
CREATE UNIQUE INDEX "trades_match_id_key" ON "trades"("match_id");

-- CreateIndex
CREATE UNIQUE INDEX "trades_external_trade_id_key" ON "trades"("external_trade_id");

-- CreateIndex
CREATE UNIQUE INDEX "trades_on_chain_trade_id_key" ON "trades"("on_chain_trade_id");

-- CreateIndex
CREATE INDEX "trades_buyer_id_status_idx" ON "trades"("buyer_id", "status");

-- CreateIndex
CREATE INDEX "trades_seller_id_status_idx" ON "trades"("seller_id", "status");

-- CreateIndex
CREATE INDEX "trades_status_idx" ON "trades"("status");

-- CreateIndex
CREATE INDEX "delivery_records_trade_id_time_slot_idx" ON "delivery_records"("trade_id", "time_slot");

-- CreateIndex
CREATE INDEX "blockchain_transactions_hedera_transaction_id_idx" ON "blockchain_transactions"("hedera_transaction_id");

-- CreateIndex
CREATE INDEX "blockchain_transactions_trade_id_created_at_idx" ON "blockchain_transactions"("trade_id", "created_at");

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "energy_records" ADD CONSTRAINT "energy_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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
ALTER TABLE "blockchain_transactions" ADD CONSTRAINT "blockchain_transactions_trade_id_fkey" FOREIGN KEY ("trade_id") REFERENCES "trades"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- =====================================================
-- B04: Domain constraints
-- =====================================================

-- User reputation must remain between 0 and 100.
ALTER TABLE "users"
ADD CONSTRAINT "users_reputation_range"
CHECK ("reputation" BETWEEN 0 AND 100);

-- Wallet key-encryption version must be positive.
ALTER TABLE "wallets"
ADD CONSTRAINT "wallets_key_version_positive"
CHECK ("key_version" >= 1);

-- Energy quantities cannot be negative.
-- net_energy_wh is signed and must be calculated
-- from production minus consumption.
ALTER TABLE "energy_records"
ADD CONSTRAINT "energy_records_quantities_valid"
CHECK (
  "production_wh" >= 0
  AND "consumption_wh" >= 0
  AND "net_energy_wh" =
      "production_wh" - "consumption_wh"
  AND (
    "available_energy_wh" IS NULL
    OR "available_energy_wh" >= 0
  )
  AND (
    "required_energy_wh" IS NULL
    OR "required_energy_wh" >= 0
  )
);

ALTER TABLE "energy_records"
ADD CONSTRAINT "energy_records_role_allowed"
CHECK (
  "market_role" IN ('SELLER', 'BUYER', 'NEUTRAL')
);

-- Match states and quantitative constraints.
ALTER TABLE "matches"
ADD CONSTRAINT "matches_status_allowed"
CHECK (
  "status" IN (
    'SELECTED',
    'TRADE_CREATED',
    'CANCELLED',
    'EXPIRED'
  )
);

ALTER TABLE "matches"
ADD CONSTRAINT "matches_values_valid"
CHECK (
  "buyer_id" <> "seller_id"
  AND "quantity_wh" > 0
  AND "unit_price_microusd_per_kwh" > 0
  AND "total_amount_microusd" > 0
  AND "distance_km" >= 0
  AND "score" BETWEEN 0 AND 1
);

-- Trade states match the Hedera escrow contract.
ALTER TABLE "trades"
ADD CONSTRAINT "trades_status_allowed"
CHECK (
  "status" IN (
    'CREATED',
    'FUNDED',
    'AWAITING_DELIVERY',
    'DELIVERED',
    'COMPLETED',
    'CANCELLED',
    'EXPIRED',
    'FAILED',
    'REFUNDED'
  )
);

ALTER TABLE "trades"
ADD CONSTRAINT "trades_values_valid"
CHECK (
  "buyer_id" <> "seller_id"
  AND "quantity_wh" > 0
  AND "unit_price_microusd_per_kwh" > 0
  AND "total_amount_microusd" > 0
  AND "delivery_deadline" > "delivery_start"
);

-- A local trade ID maps to a 32-byte hex identifier.
ALTER TABLE "trades"
ADD CONSTRAINT "trades_external_id_format"
CHECK (
  "external_trade_id" ~ '^0x[0-9a-fA-F]{64}$'
);

-- Delivery statuses follow the shared JSON schema.
ALTER TABLE "delivery_records"
ADD CONSTRAINT "delivery_records_status_allowed"
CHECK (
  "status" IN (
    'PENDING',
    'SUCCESS',
    'INCOMPLETE',
    'INVALID',
    'CONFIRMED'
  )
);

ALTER TABLE "delivery_records"
ADD CONSTRAINT "delivery_records_quantities_valid"
CHECK (
  "expected_wh" > 0
  AND "delivered_wh" >= 0
);

-- Only one CONFIRMED record is allowed for a
-- trade and delivery timestamp.
-- Other delivery attempts may be retained.
CREATE UNIQUE INDEX
  "delivery_records_one_confirmation_per_slot"
ON "delivery_records" (
  "trade_id",
  "time_slot"
)
WHERE "status" = 'CONFIRMED';

-- Blockchain fee cannot be negative.
ALTER TABLE "blockchain_transactions"
ADD CONSTRAINT "blockchain_transactions_fee_valid"
CHECK (
  "network_fee_tinybar" IS NULL
  OR "network_fee_tinybar" >= 0
);

