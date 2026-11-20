-- CreateTable
CREATE TABLE "B24Deployment" (
    "id" UUID NOT NULL,
    "status" VARCHAR(24) NOT NULL,
    "chainId" INTEGER NOT NULL,
    "contractAddress" VARCHAR(42) NOT NULL,
    "tokenAddress" VARCHAR(42) NOT NULL,
    "tokenDecimals" INTEGER NOT NULL,
    "codeHash" VARCHAR(66) NOT NULL,
    "artifactHash" VARCHAR(66) NOT NULL,
    "approvalPrincipal" VARCHAR(128) NOT NULL,
    "approvalEvidence" TEXT NOT NULL,
    "verifiedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "B24Deployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "B24SpendingPolicy" (
    "id" UUID NOT NULL,
    "buyerId" UUID NOT NULL,
    "buyerAddress" VARCHAR(42) NOT NULL,
    "deploymentId" UUID NOT NULL,
    "tokenAddress" VARCHAR(42) NOT NULL,
    "marketId" VARCHAR(66),
    "perAllocationLimit" BIGINT NOT NULL,
    "cumulativeLimit" BIGINT NOT NULL,
    "effectiveAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "consentKind" VARCHAR(32) NOT NULL,
    "version" INTEGER NOT NULL,
    "approver" VARCHAR(128) NOT NULL,
    "auditReference" TEXT NOT NULL,

    CONSTRAINT "B24SpendingPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "B24AuthorizationReservation" (
    "id" UUID NOT NULL,
    "allocationId" VARCHAR(66) NOT NULL,
    "marketId" VARCHAR(66) NOT NULL,
    "deploymentId" UUID NOT NULL,
    "policyId" UUID NOT NULL,
    "buyerAddress" VARCHAR(42) NOT NULL,
    "amountBaseUnits" BIGINT NOT NULL,
    "nonce" BIGINT NOT NULL,
    "deadline" TIMESTAMPTZ(3) NOT NULL,
    "planCommitment" VARCHAR(66) NOT NULL,
    "settlementId" VARCHAR(66) NOT NULL,
    "terms" JSONB NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'RESERVED',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "B24AuthorizationReservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "B24Deployment_chainId_contractAddress_key" ON "B24Deployment"("chainId", "contractAddress");

-- CreateIndex
CREATE UNIQUE INDEX "B24AuthorizationReservation_allocationId_key" ON "B24AuthorizationReservation"("allocationId");

-- CreateIndex
CREATE INDEX "B24AuthorizationReservation_policyId_idx" ON "B24AuthorizationReservation"("policyId");

-- CreateIndex
CREATE UNIQUE INDEX "B24AuthorizationReservation_allocationId_marketId_key" ON "B24AuthorizationReservation"("allocationId", "marketId");

-- CreateIndex
CREATE UNIQUE INDEX "B24AuthorizationReservation_deploymentId_buyerAddress_nonce_key" ON "B24AuthorizationReservation"("deploymentId", "buyerAddress", "nonce");

-- AddForeignKey
ALTER TABLE "B24SpendingPolicy" ADD CONSTRAINT "B24SpendingPolicy_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "B24SpendingPolicy" ADD CONSTRAINT "B24SpendingPolicy_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "B24Deployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "B24AuthorizationReservation" ADD CONSTRAINT "B24AuthorizationReservation_allocationId_marketId_fkey" FOREIGN KEY ("allocationId", "marketId") REFERENCES "V2Allocation"("id", "marketId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "B24AuthorizationReservation" ADD CONSTRAINT "B24AuthorizationReservation_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "B24Deployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "B24AuthorizationReservation" ADD CONSTRAINT "B24AuthorizationReservation_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "B24SpendingPolicy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- B24-A1 offline-only fixture restrictions and immutable authorization facts.
ALTER TABLE "B24Deployment" ADD CONSTRAINT "B24Deployment_values" CHECK (status IN ('TEST_FIXTURE','UNVERIFIED','RETIRED') AND "chainId">0 AND "tokenDecimals"=6 AND "contractAddress" ~ '^0x[0-9a-f]{40}$' AND "tokenAddress" ~ '^0x[0-9a-f]{40}$' AND "codeHash" ~ '^0x[0-9a-f]{64}$' AND "artifactHash" ~ '^0x[0-9a-f]{64}$' AND length("approvalEvidence")>0);
ALTER TABLE "B24SpendingPolicy" ADD CONSTRAINT "B24Policy_values" CHECK (status IN ('ACTIVE','REVOKED') AND "consentKind"='SIMULATED_TEST' AND "buyerAddress" ~ '^0x[0-9a-f]{40}$' AND "tokenAddress" ~ '^0x[0-9a-f]{40}$' AND "perAllocationLimit">0 AND "cumulativeLimit">=0 AND "expiresAt">"effectiveAt" AND version>0 AND length("auditReference")>0);
ALTER TABLE "B24AuthorizationReservation" ADD CONSTRAINT "B24Reservation_values" CHECK (status='RESERVED' AND "amountBaseUnits">0 AND nonce>=0 AND "planCommitment" ~ '^0x[0-9a-f]{64}$' AND "settlementId" ~ '^0x[0-9a-f]{64}$');
CREATE FUNCTION "b24_approval_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'B24 approval facts are immutable'; END IF;
 IF TG_OP='INSERT' THEN
  IF current_database()<>'b22_disposable_review' OR NOT EXISTS (SELECT 1 FROM b22_guard.marker WHERE value='b22-isolated-test-only') THEN RAISE EXCEPTION 'B24 fixture approvals require marked disposable database'; END IF;
  IF TG_TABLE_NAME='B24Deployment' THEN NEW."approvalPrincipal"=session_user; ELSE NEW.approver=session_user; END IF;
 ELSE
  IF session_user='b24_evaluator' THEN RAISE EXCEPTION 'evaluator cannot alter approvals' USING ERRCODE='42501'; END IF;
  IF (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') OR (TG_TABLE_NAME='B24SpendingPolicy' AND NOT (OLD.status='ACTIVE' AND NEW.status='REVOKED')) OR (TG_TABLE_NAME='B24Deployment' AND NOT (OLD.status='TEST_FIXTURE' AND NEW.status='RETIRED')) THEN RAISE EXCEPTION 'B24 approval facts are immutable'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "B24Deployment_guard" BEFORE INSERT OR UPDATE OR DELETE ON "B24Deployment" FOR EACH ROW EXECUTE FUNCTION "b24_approval_guard"();
CREATE TRIGGER "B24Policy_guard" BEFORE INSERT OR UPDATE OR DELETE ON "B24SpendingPolicy" FOR EACH ROW EXECUTE FUNCTION "b24_approval_guard"();
CREATE FUNCTION "b24_reservation_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p "B24SpendingPolicy"%ROWTYPE; d "B24Deployment"%ROWTYPE; a "V2Allocation"%ROWTYPE; spent numeric;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'B24 reservations are immutable'; END IF;
 IF current_database()<>'b22_disposable_review' OR NOT EXISTS (SELECT 1 FROM b22_guard.marker WHERE value='b22-isolated-test-only') THEN RAISE EXCEPTION 'B24 reservations require marked disposable database'; END IF;
 SELECT * INTO p FROM "B24SpendingPolicy" WHERE id=NEW."policyId" FOR UPDATE;
 SELECT * INTO d FROM "B24Deployment" WHERE id=NEW."deploymentId" FOR UPDATE;
 SELECT * INTO a FROM "V2Allocation" WHERE id=NEW."allocationId" AND "marketId"=NEW."marketId";
 IF p.id IS NULL OR d.id IS NULL OR a.id IS NULL OR p.status<>'ACTIVE' OR p."consentKind"<>'SIMULATED_TEST' OR d.status<>'TEST_FIXTURE' OR p."deploymentId"<>d.id OR p."buyerId"<>a."buyerId" OR p."buyerAddress"<>a."buyerAddress" OR NEW."buyerAddress"<>a."buyerAddress" OR p."tokenAddress"<>d."tokenAddress" OR (p."marketId" IS NOT NULL AND p."marketId"<>a."marketId") OR a.status<>'VALIDATED' OR NEW."amountBaseUnits"<>a."amountBaseUnits" OR a.remainder<>0 OR NOT EXISTS (SELECT 1 FROM "V2AllocationPlan" plan JOIN "V2Snapshot" s ON s.id=plan."snapshotId" WHERE plan.id=a."planId" AND plan.status='AUTHORITATIVE' AND s.status='FINALIZED') THEN RAISE EXCEPTION 'B24 reservation context invalid'; END IF;
 IF NEW.terms->>'settlementId' IS DISTINCT FROM NEW."settlementId" OR NEW.terms->'terms'->>'allocationId' IS DISTINCT FROM a.id OR NEW.terms->'terms'->>'marketId' IS DISTINCT FROM a."marketId" OR NEW.terms->'terms'->>'snapshotHash' IS DISTINCT FROM (SELECT "payloadHash" FROM "V2Snapshot" WHERE id=a."snapshotId") OR lower(NEW.terms->'terms'->>'buyer') IS DISTINCT FROM a."buyerAddress" OR lower(NEW.terms->'terms'->>'seller') IS DISTINCT FROM a."sellerAddress" OR lower(NEW.terms->'terms'->>'token') IS DISTINCT FROM d."tokenAddress" OR NEW.terms->'terms'->>'quantityWh' IS DISTINCT FROM a."quantityWh"::text OR NEW.terms->'terms'->>'unitPriceMicrousdPerKwh' IS DISTINCT FROM a."unitPriceMicrousdPerKwh"::text OR NEW.terms->'terms'->>'amountBaseUnits' IS DISTINCT FROM a."amountBaseUnits"::text OR NEW.terms->'terms'->>'planCommitment' IS DISTINCT FROM NEW."planCommitment" OR NEW.terms->'terms'->>'nonce' IS DISTINCT FROM NEW.nonce::text OR NEW.terms->'terms'->>'deadline' IS DISTINCT FROM (extract(epoch FROM NEW.deadline)::bigint)::text OR NEW.terms->'domain'->>'chainId' IS DISTINCT FROM d."chainId"::text OR lower(NEW.terms->'domain'->>'verifyingContract') IS DISTINCT FROM d."contractAddress" THEN RAISE EXCEPTION 'B24 unsigned terms mismatch'; END IF;
 IF now()<p."effectiveAt" OR now()>=p."expiresAt" OR NEW.deadline<=now() OR NEW.deadline>p."expiresAt" OR NEW.deadline>now()+interval '10 minutes' THEN RAISE EXCEPTION 'B24 policy or deadline invalid'; END IF;
 SELECT coalesce(sum("amountBaseUnits"),0) INTO spent FROM "B24AuthorizationReservation" WHERE "policyId"=p.id;
 IF NEW."amountBaseUnits">p."perAllocationLimit" OR spent+NEW."amountBaseUnits">p."cumulativeLimit" THEN RAISE EXCEPTION 'B24 budget exceeded'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "B24Reservation_guard" BEFORE INSERT OR UPDATE OR DELETE ON "B24AuthorizationReservation" FOR EACH ROW EXECUTE FUNCTION "b24_reservation_guard"();
