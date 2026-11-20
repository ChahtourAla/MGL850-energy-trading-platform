-- CreateTable
CREATE TABLE "V2Market" (
    "id" VARCHAR(66) NOT NULL,
    "namespace" VARCHAR(80) NOT NULL,
    "mode" VARCHAR(16) NOT NULL,
    "intervalStart" TIMESTAMPTZ(3) NOT NULL,
    "intervalEnd" TIMESTAMPTZ(3) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'DISCOVERED',
    "schemaVersion" VARCHAR(16) NOT NULL,
    "configVersion" VARCHAR(128) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "V2Market_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "V2Snapshot" (
    "id" UUID NOT NULL,
    "marketId" VARCHAR(66) NOT NULL,
    "intervalStart" TIMESTAMPTZ(3) NOT NULL,
    "intervalEnd" TIMESTAMPTZ(3) NOT NULL,
    "sourceIdentity" VARCHAR(128) NOT NULL,
    "sourceVersion" VARCHAR(128) NOT NULL,
    "configHash" VARCHAR(66) NOT NULL,
    "payloadHash" VARCHAR(66) NOT NULL,
    "schemaVersion" VARCHAR(16) NOT NULL,
    "expectedCount" INTEGER NOT NULL,
    "actualCount" INTEGER NOT NULL,
    "completeness" JSONB NOT NULL,
    "collectedAt" TIMESTAMPTZ(3) NOT NULL,
    "finalizedAt" TIMESTAMPTZ(3),
    "finalizer" VARCHAR(128),
    "status" VARCHAR(24) NOT NULL DEFAULT 'PENDING',
    "supersedesId" UUID,

    CONSTRAINT "V2Snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "V2Position" (
    "marketId" VARCHAR(66) NOT NULL,
    "userId" UUID NOT NULL,
    "productionWh" BIGINT NOT NULL,
    "consumptionWh" BIGINT NOT NULL,
    "netEnergyWh" BIGINT NOT NULL,
    "role" VARCHAR(16) NOT NULL,
    "availableWh" BIGINT NOT NULL,
    "requiredWh" BIGINT NOT NULL,
    "matchedBoughtWh" BIGINT NOT NULL,
    "matchedSoldWh" BIGINT NOT NULL,
    "unmatchedDeficitWh" BIGINT NOT NULL,
    "unmatchedSurplusWh" BIGINT NOT NULL,

    CONSTRAINT "V2Position_pkey" PRIMARY KEY ("marketId","userId")
);

-- CreateTable
CREATE TABLE "V2Allocation" (
    "id" VARCHAR(66) NOT NULL,
    "marketId" VARCHAR(66) NOT NULL,
    "snapshotId" UUID NOT NULL,
    "buyerId" UUID NOT NULL,
    "sellerId" UUID NOT NULL,
    "buyerAddress" VARCHAR(42) NOT NULL,
    "sellerAddress" VARCHAR(42) NOT NULL,
    "quantityWh" BIGINT NOT NULL,
    "unitPriceMicrousdPerKwh" BIGINT NOT NULL,
    "amountBaseUnits" BIGINT NOT NULL,
    "remainder" INTEGER NOT NULL,
    "algorithmVersion" VARCHAR(128) NOT NULL,
    "pricingVersion" VARCHAR(128) NOT NULL,
    "planVersion" VARCHAR(128) NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'PLANNED',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "V2Allocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "V2SettlementIntent" (
    "id" VARCHAR(66) NOT NULL,
    "allocationId" VARCHAR(66) NOT NULL,
    "marketId" VARCHAR(66) NOT NULL,
    "chainId" INTEGER NOT NULL,
    "tokenAddress" VARCHAR(42) NOT NULL,
    "contractAddress" VARCHAR(42),
    "amountBaseUnits" BIGINT NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'PLANNED',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "V2SettlementIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "V2SettlementAttempt" (
    "id" UUID NOT NULL,
    "settlementId" VARCHAR(66) NOT NULL,
    "sequence" INTEGER NOT NULL,
    "status" VARCHAR(24) NOT NULL,
    "txHash" VARCHAR(66),
    "transactionIdentity" VARCHAR(128),
    "nonce" BIGINT,
    "errorCode" VARCHAR(128),
    "recoveryMetadata" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "V2SettlementAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "V2SettlementEvidence" (
    "id" UUID NOT NULL,
    "settlementId" VARCHAR(66) NOT NULL,
    "chainId" INTEGER NOT NULL,
    "contractAddress" VARCHAR(42) NOT NULL,
    "tokenAddress" VARCHAR(42) NOT NULL,
    "txHash" VARCHAR(66) NOT NULL,
    "blockReference" VARCHAR(128),
    "receiptStatus" VARCHAR(16) NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "buyerAddress" VARCHAR(42) NOT NULL,
    "sellerAddress" VARCHAR(42) NOT NULL,
    "amountBaseUnits" BIGINT NOT NULL,
    "confirmedAt" TIMESTAMPTZ(3) NOT NULL,
    "verificationStatus" VARCHAR(24) NOT NULL,

    CONSTRAINT "V2SettlementEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "V2Market_status_intervalEnd_idx" ON "V2Market"("status", "intervalEnd");

-- CreateIndex
CREATE UNIQUE INDEX "V2Market_namespace_intervalStart_intervalEnd_key" ON "V2Market"("namespace", "intervalStart", "intervalEnd");

-- CreateIndex
CREATE INDEX "V2Snapshot_marketId_status_idx" ON "V2Snapshot"("marketId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "V2Snapshot_id_marketId_key" ON "V2Snapshot"("id", "marketId");

-- CreateIndex
CREATE INDEX "V2Allocation_marketId_buyerId_idx" ON "V2Allocation"("marketId", "buyerId");

-- CreateIndex
CREATE INDEX "V2Allocation_marketId_sellerId_idx" ON "V2Allocation"("marketId", "sellerId");

-- CreateIndex
CREATE UNIQUE INDEX "V2Allocation_id_marketId_key" ON "V2Allocation"("id", "marketId");

-- CreateIndex
CREATE UNIQUE INDEX "V2SettlementIntent_allocationId_key" ON "V2SettlementIntent"("allocationId");

-- CreateIndex
CREATE INDEX "V2SettlementIntent_status_updatedAt_idx" ON "V2SettlementIntent"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "V2SettlementIntent_allocationId_marketId_key" ON "V2SettlementIntent"("allocationId", "marketId");

-- CreateIndex
CREATE INDEX "V2SettlementAttempt_txHash_idx" ON "V2SettlementAttempt"("txHash");

-- CreateIndex
CREATE INDEX "V2SettlementAttempt_transactionIdentity_idx" ON "V2SettlementAttempt"("transactionIdentity");

-- CreateIndex
CREATE UNIQUE INDEX "V2SettlementAttempt_settlementId_sequence_key" ON "V2SettlementAttempt"("settlementId", "sequence");

-- CreateIndex
CREATE INDEX "V2SettlementEvidence_settlementId_verificationStatus_idx" ON "V2SettlementEvidence"("settlementId", "verificationStatus");

-- CreateIndex
CREATE UNIQUE INDEX "V2SettlementEvidence_chainId_txHash_logIndex_key" ON "V2SettlementEvidence"("chainId", "txHash", "logIndex");

-- AddForeignKey
ALTER TABLE "V2Snapshot" ADD CONSTRAINT "V2Snapshot_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "V2Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "V2Snapshot" ADD CONSTRAINT "V2Snapshot_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "V2Snapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "V2Position" ADD CONSTRAINT "V2Position_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "V2Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "V2Position" ADD CONSTRAINT "V2Position_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "V2Allocation" ADD CONSTRAINT "V2Allocation_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "V2Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "V2Allocation" ADD CONSTRAINT "V2Allocation_snapshotId_marketId_fkey" FOREIGN KEY ("snapshotId", "marketId") REFERENCES "V2Snapshot"("id", "marketId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "V2Allocation" ADD CONSTRAINT "V2Allocation_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "V2Allocation" ADD CONSTRAINT "V2Allocation_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "V2SettlementIntent" ADD CONSTRAINT "V2SettlementIntent_allocationId_marketId_fkey" FOREIGN KEY ("allocationId", "marketId") REFERENCES "V2Allocation"("id", "marketId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "V2SettlementAttempt" ADD CONSTRAINT "V2SettlementAttempt_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "V2SettlementIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "V2SettlementEvidence" ADD CONSTRAINT "V2SettlementEvidence_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "V2SettlementIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


CREATE UNIQUE INDEX "V2Allocation_logical_key" ON "V2Allocation" ("marketId", "snapshotId", "buyerId", "sellerId", "buyerAddress", "sellerAddress", "quantityWh", "unitPriceMicrousdPerKwh", "algorithmVersion", "pricingVersion", "planVersion");

-- B21 domain checks. Cross-row finality and evidence validation require future services.
ALTER TABLE "V2Market" ADD CONSTRAINT "V2Market_interval_check" CHECK ("intervalEnd" > "intervalStart" AND (("mode" = 'HOURLY' AND "namespace" = 'hourly' AND date_trunc('hour', "intervalStart" AT TIME ZONE 'UTC') = "intervalStart" AT TIME ZONE 'UTC' AND "intervalEnd" = "intervalStart" + INTERVAL '1 hour') OR ("mode" = 'SIMULATION' AND "namespace" LIKE 'simulation:%')));
ALTER TABLE "V2Market" ADD CONSTRAINT "V2Market_status_check" CHECK ("status" IN ('DISCOVERED','WAITING_DATA','FINALIZED','MATCHED','SETTLING','COMPLETE','INVALID','QUARANTINED','PARTIAL','RECONCILIATION_REQUIRED'));
ALTER TABLE "V2Snapshot" ADD CONSTRAINT "V2Snapshot_counts_check" CHECK ("expectedCount" >= 0 AND "actualCount" >= 0 AND "actualCount" <= "expectedCount" AND "intervalEnd" > "intervalStart" AND "status" IN ('PENDING','INVALID','FINALIZED') AND ("status" <> 'FINALIZED' OR ("actualCount" = "expectedCount" AND "finalizedAt" IS NOT NULL AND "finalizer" IS NOT NULL)));
ALTER TABLE "V2Position" ADD CONSTRAINT "V2Position_energy_check" CHECK ("productionWh" >= 0 AND "consumptionWh" >= 0 AND "netEnergyWh"::numeric = "productionWh"::numeric - "consumptionWh"::numeric AND "availableWh" >= 0 AND "requiredWh" >= 0 AND "matchedBoughtWh" >= 0 AND "matchedSoldWh" >= 0 AND "unmatchedDeficitWh" >= 0 AND "unmatchedSurplusWh" >= 0 AND (("role" = 'BUYER' AND "netEnergyWh" < 0 AND "requiredWh"::numeric = -"netEnergyWh"::numeric AND "availableWh" = 0 AND "matchedSoldWh" = 0 AND "unmatchedSurplusWh" = 0 AND "matchedBoughtWh"::numeric + "unmatchedDeficitWh" = "requiredWh") OR ("role" = 'SELLER' AND "netEnergyWh" > 0 AND "availableWh" = "netEnergyWh" AND "requiredWh" = 0 AND "matchedBoughtWh" = 0 AND "unmatchedDeficitWh" = 0 AND "matchedSoldWh"::numeric + "unmatchedSurplusWh" = "availableWh") OR ("role" = 'NEUTRAL' AND "netEnergyWh" = 0 AND "availableWh" = 0 AND "requiredWh" = 0 AND "matchedBoughtWh" = 0 AND "matchedSoldWh" = 0 AND "unmatchedDeficitWh" = 0 AND "unmatchedSurplusWh" = 0)));
ALTER TABLE "V2Allocation" ADD CONSTRAINT "V2Allocation_terms_check" CHECK ("buyerId" <> "sellerId" AND "buyerAddress" <> "sellerAddress" AND "quantityWh" > 0 AND "unitPriceMicrousdPerKwh" > 0 AND "amountBaseUnits" >= 0 AND "remainder" BETWEEN 0 AND 999 AND "quantityWh"::numeric * "unitPriceMicrousdPerKwh"::numeric = "amountBaseUnits"::numeric * 1000 + "remainder");
ALTER TABLE "V2SettlementIntent" ADD CONSTRAINT "V2Intent_values_check" CHECK ("chainId" = 296 AND "amountBaseUnits" >= 0 AND "status" IN ('PLANNED','READY','SIGNED','SUBMITTED','CONFIRMED','PROJECTED','BLOCKED','REVERTED','UNKNOWN'));
ALTER TABLE "V2SettlementAttempt" ADD CONSTRAINT "V2Attempt_values_check" CHECK ("sequence" > 0 AND ("nonce" IS NULL OR "nonce" >= 0));
ALTER TABLE "V2SettlementEvidence" ADD CONSTRAINT "V2Evidence_values_check" CHECK ("chainId" = 296 AND "logIndex" >= 0 AND "amountBaseUnits" >= 0 AND "receiptStatus" IN ('SUCCESS','FAILED') AND "verificationStatus" IN ('PENDING','VERIFIED','REJECTED') AND ("verificationStatus" <> 'VERIFIED' OR "receiptStatus" = 'SUCCESS'));

ALTER TABLE "V2SettlementAttempt" ADD CONSTRAINT "V2Attempt_status_check" CHECK ("status" IN ('PLANNED','SIGNED','SUBMITTED','CONFIRMED','REVERTED','UNKNOWN','NEEDS_RECONCILIATION'));

-- Immutable facts and cross-record checks. Application authorization and actual
-- Hedera verification remain B25 responsibilities. No trigger signs or sends.
CREATE UNIQUE INDEX "V2Evidence_one_verified_per_settlement" ON "V2SettlementEvidence"("settlementId") WHERE "verificationStatus" = 'VERIFIED';

CREATE FUNCTION "v2_snapshot_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m "V2Market"%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" = 'FINALIZED' THEN RAISE EXCEPTION 'finalized snapshot is immutable'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = 'FINALIZED' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'finalized snapshot is immutable; use supersession';
  END IF;
  SELECT * INTO m FROM "V2Market" WHERE "id"=NEW."marketId" FOR UPDATE;
  IF NOT FOUND OR NEW."intervalStart" <> m."intervalStart" OR NEW."intervalEnd" <> m."intervalEnd" THEN RAISE EXCEPTION 'snapshot market interval mismatch'; END IF;
  IF NEW."supersedesId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "V2Snapshot" WHERE "id"=NEW."supersedesId" AND "marketId"=NEW."marketId" AND "id"<>NEW."id") THEN RAISE EXCEPTION 'invalid snapshot supersession'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "V2Snapshot_guard" BEFORE INSERT OR UPDATE OR DELETE ON "V2Snapshot" FOR EACH ROW EXECUTE FUNCTION "v2_snapshot_guard"();

CREATE FUNCTION "v2_allocation_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE snap "V2Snapshot"%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'allocation facts are immutable'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status') THEN RAISE EXCEPTION 'allocation facts are immutable'; END IF;
  END IF;
  PERFORM 1 FROM "V2Market" WHERE "id"=NEW."marketId" FOR UPDATE;
  SELECT * INTO snap FROM "V2Snapshot" WHERE "id"=NEW."snapshotId" AND "marketId"=NEW."marketId" FOR UPDATE;
  IF NOT FOUND OR snap."status" <> 'FINALIZED' THEN RAISE EXCEPTION 'allocation requires finalized snapshot'; END IF;
  IF EXISTS (SELECT 1 FROM "V2Allocation" WHERE "marketId"=NEW."marketId" AND "snapshotId"<>NEW."snapshotId") THEN RAISE EXCEPTION 'market already locked to another snapshot'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "V2Allocation_guard" BEFORE INSERT OR UPDATE OR DELETE ON "V2Allocation" FOR EACH ROW EXECUTE FUNCTION "v2_allocation_guard"();

CREATE FUNCTION "v2_intent_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a "V2Allocation"%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'intent facts are immutable'; END IF;
  IF TG_OP='UPDATE' AND (NEW."id",NEW."allocationId",NEW."marketId",NEW."chainId",NEW."tokenAddress",NEW."amountBaseUnits") IS DISTINCT FROM (OLD."id",OLD."allocationId",OLD."marketId",OLD."chainId",OLD."tokenAddress",OLD."amountBaseUnits") THEN RAISE EXCEPTION 'intent facts are immutable'; END IF;
  IF TG_OP='UPDATE' AND OLD."contractAddress" IS NOT NULL AND NEW."contractAddress" IS DISTINCT FROM OLD."contractAddress" THEN RAISE EXCEPTION 'intent contract is immutable once assigned'; END IF;
  SELECT * INTO a FROM "V2Allocation" WHERE "id"=NEW."allocationId" AND "marketId"=NEW."marketId";
  IF NOT FOUND OR a."amountBaseUnits"<>NEW."amountBaseUnits" THEN RAISE EXCEPTION 'intent allocation mismatch'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "V2Intent_guard" BEFORE INSERT OR UPDATE OR DELETE ON "V2SettlementIntent" FOR EACH ROW EXECUTE FUNCTION "v2_intent_guard"();

CREATE FUNCTION "v2_evidence_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i "V2SettlementIntent"%ROWTYPE; a "V2Allocation"%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD."verificationStatus"='VERIFIED' THEN RAISE EXCEPTION 'verified evidence is immutable'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' AND OLD."verificationStatus"='VERIFIED' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'verified evidence is immutable'; END IF;
  SELECT * INTO i FROM "V2SettlementIntent" WHERE "id"=NEW."settlementId" FOR UPDATE;
  SELECT * INTO a FROM "V2Allocation" WHERE "id"=i."allocationId";
  IF i."id" IS NULL OR a."id" IS NULL OR NEW."chainId"<>i."chainId" OR NEW."tokenAddress"<>i."tokenAddress" OR NEW."contractAddress" IS DISTINCT FROM i."contractAddress" OR NEW."amountBaseUnits"<>i."amountBaseUnits" OR NEW."buyerAddress"<>a."buyerAddress" OR NEW."sellerAddress"<>a."sellerAddress" THEN RAISE EXCEPTION 'evidence terms mismatch'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "V2Evidence_guard" BEFORE INSERT OR UPDATE OR DELETE ON "V2SettlementEvidence" FOR EACH ROW EXECUTE FUNCTION "v2_evidence_guard"();

CREATE FUNCTION "v2_confirmed_requires_evidence"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "V2SettlementIntent" i WHERE i."id"=NEW."id" AND i."status" IN ('CONFIRMED','PROJECTED') AND NOT EXISTS (SELECT 1 FROM "V2SettlementEvidence" e WHERE e."settlementId"=i."id" AND e."verificationStatus"='VERIFIED' AND e."receiptStatus"='SUCCESS')) THEN RAISE EXCEPTION 'confirmed intent requires verified evidence'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "V2Intent_confirmed_evidence" AFTER INSERT OR UPDATE ON "V2SettlementIntent" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "v2_confirmed_requires_evidence"();

CREATE FUNCTION "v2_market_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW."id",NEW."namespace",NEW."mode",NEW."intervalStart",NEW."intervalEnd",NEW."schemaVersion") IS DISTINCT FROM (OLD."id",OLD."namespace",OLD."mode",OLD."intervalStart",OLD."intervalEnd",OLD."schemaVersion") THEN RAISE EXCEPTION 'market identity is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "V2Market_guard" BEFORE UPDATE ON "V2Market" FOR EACH ROW EXECUTE FUNCTION "v2_market_guard"();
ALTER TABLE "V2Market" ADD CONSTRAINT "V2Market_format_check" CHECK ("id" ~ '^0x[0-9a-f]{64}$' AND "schemaVersion"='2.0.0' AND ("mode" <> 'SIMULATION' OR "namespace" ~ '^simulation:[a-z0-9][a-z0-9_-]{0,63}$'));
ALTER TABLE "V2Snapshot" ADD CONSTRAINT "V2Snapshot_format_check" CHECK ("schemaVersion"='2.0.0' AND "configHash" ~ '^0x[0-9a-f]{64}$' AND "payloadHash" ~ '^0x[0-9a-f]{64}$');
ALTER TABLE "V2Allocation" ADD CONSTRAINT "V2Allocation_format_check" CHECK ("id" ~ '^0x[0-9a-f]{64}$' AND "buyerAddress" ~ '^0x[0-9a-f]{40}$' AND "sellerAddress" ~ '^0x[0-9a-f]{40}$' AND "status" IN ('PLANNED','VALIDATED','CANCELLED'));
ALTER TABLE "V2SettlementIntent" ADD CONSTRAINT "V2Intent_format_check" CHECK ("id" ~ '^0x[0-9a-f]{64}$' AND "tokenAddress" ~ '^0x[0-9a-f]{40}$' AND ("contractAddress" IS NULL OR "contractAddress" ~ '^0x[0-9a-f]{40}$'));
ALTER TABLE "V2SettlementEvidence" ADD CONSTRAINT "V2Evidence_format_check" CHECK ("txHash" ~ '^0x[0-9a-f]{64}$' AND "contractAddress" ~ '^0x[0-9a-f]{40}$' AND "tokenAddress" ~ '^0x[0-9a-f]{40}$' AND "buyerAddress" ~ '^0x[0-9a-f]{40}$' AND "sellerAddress" ~ '^0x[0-9a-f]{40}$');
CREATE FUNCTION "v2_position_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM "V2Market" WHERE "id"=OLD."marketId" FOR UPDATE;
  IF EXISTS (SELECT 1 FROM "V2Snapshot" WHERE "marketId"=OLD."marketId" AND "status"='FINALIZED') THEN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'finalized participant measurement is immutable'; END IF;
    IF (NEW."marketId",NEW."userId",NEW."productionWh",NEW."consumptionWh",NEW."netEnergyWh",NEW."role",NEW."availableWh",NEW."requiredWh") IS DISTINCT FROM (OLD."marketId",OLD."userId",OLD."productionWh",OLD."consumptionWh",OLD."netEnergyWh",OLD."role",OLD."availableWh",OLD."requiredWh") THEN RAISE EXCEPTION 'finalized participant measurement is immutable'; END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "V2Position_guard" BEFORE UPDATE OR DELETE ON "V2Position" FOR EACH ROW EXECUTE FUNCTION "v2_position_guard"();
