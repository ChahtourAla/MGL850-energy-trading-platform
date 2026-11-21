-- Draft only: immutable operation identities, no execution privileges are granted.
-- No user or chain operation is created by this migration.
CREATE TABLE "B24SigningOperation" (
 "id" UUID PRIMARY KEY, "reservationId" UUID NOT NULL UNIQUE REFERENCES "B24AuthorizationReservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "idempotencyKey" VARCHAR(128) NOT NULL UNIQUE, "principal" VARCHAR(128) NOT NULL,
 "state" VARCHAR(24) NOT NULL DEFAULT 'REQUESTED' CHECK ("state"='REQUESTED'),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK (length("idempotencyKey")>0 AND length("principal")>0)
);
CREATE TABLE "B24FundingOperation" (
 "id" UUID PRIMARY KEY, "reservationId" UUID NOT NULL REFERENCES "B24AuthorizationReservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "idempotencyKey" VARCHAR(128) NOT NULL UNIQUE, "principal" VARCHAR(128) NOT NULL,
 "amountBaseUnits" BIGINT NOT NULL CHECK ("amountBaseUnits">0), "sessionId" VARCHAR(128) NOT NULL,
 "state" VARCHAR(24) NOT NULL DEFAULT 'PREPARED' CHECK ("state"='PREPARED'),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK (length("idempotencyKey")>0 AND length("principal")>0 AND length("sessionId")>0)
);
CREATE INDEX "B24FundingOperation_reservationId_idx" ON "B24FundingOperation"("reservationId");
CREATE TABLE "B24AllowanceOperation" (
 "id" UUID PRIMARY KEY, "reservationId" UUID NOT NULL REFERENCES "B24AuthorizationReservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "idempotencyKey" VARCHAR(128) NOT NULL UNIQUE, "principal" VARCHAR(128) NOT NULL,
 "amountBaseUnits" BIGINT NOT NULL CHECK ("amountBaseUnits">=0), "sessionId" VARCHAR(128) NOT NULL,
 "state" VARCHAR(24) NOT NULL DEFAULT 'PREPARED' CHECK ("state"='PREPARED'),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK (length("idempotencyKey")>0 AND length("principal")>0 AND length("sessionId")>0)
);
CREATE INDEX "B24AllowanceOperation_reservationId_idx" ON "B24AllowanceOperation"("reservationId");
CREATE FUNCTION "b24_draft_journal_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'draft B24 operation records are immutable'; END $$;
CREATE TRIGGER "B24SigningOperation_immutable" BEFORE UPDATE OR DELETE ON "B24SigningOperation" FOR EACH ROW EXECUTE FUNCTION "b24_draft_journal_immutable"();
CREATE TRIGGER "B24FundingOperation_immutable" BEFORE UPDATE OR DELETE ON "B24FundingOperation" FOR EACH ROW EXECUTE FUNCTION "b24_draft_journal_immutable"();
CREATE TRIGGER "B24AllowanceOperation_immutable" BEFORE UPDATE OR DELETE ON "B24AllowanceOperation" FOR EACH ROW EXECUTE FUNCTION "b24_draft_journal_immutable"();
REVOKE ALL ON "B24SigningOperation", "B24FundingOperation", "B24AllowanceOperation" FROM PUBLIC;
