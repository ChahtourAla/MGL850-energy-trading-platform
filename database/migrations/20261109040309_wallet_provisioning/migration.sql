-- CreateTable
CREATE TABLE "wallet_provisioning" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "public_key" TEXT NOT NULL,
    "evm_address" VARCHAR(42) NOT NULL,
    "encrypted_private_key" TEXT NOT NULL,
    "encryption_iv" TEXT NOT NULL,
    "encryption_auth_tag" TEXT NOT NULL,
    "key_version" INTEGER NOT NULL DEFAULT 1,
    "transaction_id" VARCHAR(128) NOT NULL,
    "state" VARCHAR(32) NOT NULL DEFAULT 'PREPARED',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "wallet_provisioning_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wallet_provisioning_user_id_key" ON "wallet_provisioning"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_provisioning_evm_address_key" ON "wallet_provisioning"("evm_address");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_provisioning_transaction_id_key" ON "wallet_provisioning"("transaction_id");

-- CreateIndex
CREATE INDEX "wallet_provisioning_state_created_at_idx" ON "wallet_provisioning"("state", "created_at");

-- AddForeignKey
ALTER TABLE "wallet_provisioning" ADD CONSTRAINT "wallet_provisioning_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "wallet_provisioning"
ADD CONSTRAINT "wallet_provisioning_state_allowed"
CHECK (
  "state" IN (
    'PREPARED',
    'SUBMITTED',
    'NEEDS_RECONCILIATION'
  )
);