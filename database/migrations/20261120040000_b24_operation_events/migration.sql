-- Additive draft: append-only event history. No runtime privileges or terminal success states.
CREATE TABLE "B24OperationEvent" (
 "id" UUID PRIMARY KEY,
 "signingOperationId" UUID REFERENCES "B24SigningOperation"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "fundingOperationId" UUID REFERENCES "B24FundingOperation"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "allowanceOperationId" UUID REFERENCES "B24AllowanceOperation"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "sequence" INTEGER NOT NULL CHECK ("sequence">0),
 "state" VARCHAR(24) NOT NULL,
 "actor" VARCHAR(128) NOT NULL,
 "txHash" VARCHAR(66),
 "reason" TEXT,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK (num_nonnulls("signingOperationId","fundingOperationId","allowanceOperationId")=1),
 CHECK ("txHash" IS NULL OR "txHash" ~ '^0x[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX "B24OperationEvent_signingOperationId_sequence_key" ON "B24OperationEvent"("signingOperationId","sequence");
CREATE UNIQUE INDEX "B24OperationEvent_fundingOperationId_sequence_key" ON "B24OperationEvent"("fundingOperationId","sequence");
CREATE UNIQUE INDEX "B24OperationEvent_allowanceOperationId_sequence_key" ON "B24OperationEvent"("allowanceOperationId","sequence");
CREATE FUNCTION "b24_draft_event_guard"() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE previous_state text; previous_sequence integer; operation_state text;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'B24 operation events are append-only'; END IF;
 NEW."actor" := session_user;
 IF NEW."signingOperationId" IS NOT NULL THEN
  SELECT "state" INTO operation_state FROM public."B24SigningOperation" WHERE id=NEW."signingOperationId" FOR UPDATE;
  SELECT "state","sequence" INTO previous_state,previous_sequence FROM public."B24OperationEvent" WHERE "signingOperationId"=NEW."signingOperationId" ORDER BY "sequence" DESC LIMIT 1;
 ELSEIF NEW."fundingOperationId" IS NOT NULL THEN
  SELECT "state" INTO operation_state FROM public."B24FundingOperation" WHERE id=NEW."fundingOperationId" FOR UPDATE;
  SELECT "state","sequence" INTO previous_state,previous_sequence FROM public."B24OperationEvent" WHERE "fundingOperationId"=NEW."fundingOperationId" ORDER BY "sequence" DESC LIMIT 1;
 ELSE
  SELECT "state" INTO operation_state FROM public."B24AllowanceOperation" WHERE id=NEW."allowanceOperationId" FOR UPDATE;
  SELECT "state","sequence" INTO previous_state,previous_sequence FROM public."B24OperationEvent" WHERE "allowanceOperationId"=NEW."allowanceOperationId" ORDER BY "sequence" DESC LIMIT 1;
 END IF;
 IF operation_state IS NULL THEN RAISE EXCEPTION 'B24 operation not found'; END IF;
 IF NEW."sequence"<>coalesce(previous_sequence,0)+1 THEN RAISE EXCEPTION 'B24 event sequence invalid'; END IF;
 previous_state := coalesce(previous_state,operation_state);
 -- No authenticated signer or receipt verifier exists yet. Terminal success remains impossible.
 IF NEW."signingOperationId" IS NOT NULL THEN
  IF NOT (previous_state='REQUESTED' AND NEW."state" IN ('BLOCKED','FAILED','UNRESOLVED')) THEN RAISE EXCEPTION 'B24 signing transition not enabled'; END IF;
  IF NEW."txHash" IS NOT NULL THEN RAISE EXCEPTION 'B24 signing event cannot have transaction hash'; END IF;
 ELSE
  IF NOT ((previous_state='PREPARED' AND NEW."state" IN ('SUBMITTED','FAILED','UNRESOLVED')) OR (previous_state='SUBMITTED' AND NEW."state" IN ('FAILED','UNRESOLVED'))) THEN RAISE EXCEPTION 'B24 transaction transition not enabled'; END IF;
  IF NEW."state"='SUBMITTED' AND NEW."txHash" IS NULL THEN RAISE EXCEPTION 'B24 submitted transaction requires hash'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "B24OperationEvent_guard" BEFORE INSERT OR UPDATE OR DELETE ON "B24OperationEvent" FOR EACH ROW EXECUTE FUNCTION "b24_draft_event_guard"();
REVOKE ALL ON "B24OperationEvent" FROM PUBLIC;
