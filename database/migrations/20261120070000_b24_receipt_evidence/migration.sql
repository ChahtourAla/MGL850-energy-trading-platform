-- Offline prototype only. A separate verifier is trusted to inspect the real local chain.
CREATE TABLE "B24ReceiptEvidence" (
 "id" UUID PRIMARY KEY,
 "fundingOperationId" UUID UNIQUE REFERENCES "B24FundingOperation"("id") ON DELETE RESTRICT,
 "allowanceOperationId" UUID UNIQUE REFERENCES "B24AllowanceOperation"("id") ON DELETE RESTRICT,
 "txHash" VARCHAR(66) NOT NULL,
 "blockHash" VARCHAR(66) NOT NULL,
 "blockNumber" BIGINT NOT NULL CHECK ("blockNumber">=0),
 "logIndex" INTEGER NOT NULL CHECK ("logIndex">=0),
 "sessionId" VARCHAR(128) NOT NULL,
 "tokenAddress" VARCHAR(42) NOT NULL,
 "buyerAddress" VARCHAR(42) NOT NULL,
 "spenderAddress" VARCHAR(42),
 "amountBaseUnits" BIGINT NOT NULL CHECK ("amountBaseUnits">=0),
 "verifiedBy" VARCHAR(128) NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK (num_nonnulls("fundingOperationId","allowanceOperationId")=1),
 CHECK ("txHash" ~ '^0x[0-9a-f]{64}$' AND "blockHash" ~ '^0x[0-9a-f]{64}$'),
 CHECK ("tokenAddress" ~ '^0x[0-9a-f]{40}$' AND "buyerAddress" ~ '^0x[0-9a-f]{40}$'),
 CHECK ("spenderAddress" IS NULL OR "spenderAddress" ~ '^0x[0-9a-f]{40}$'),
 UNIQUE ("sessionId","txHash","logIndex")
);
CREATE TRIGGER "B24ReceiptEvidence_immutable" BEFORE UPDATE OR DELETE ON "B24ReceiptEvidence" FOR EACH ROW EXECUTE FUNCTION "b24_draft_journal_immutable"();
REVOKE ALL ON "B24ReceiptEvidence" FROM PUBLIC;

-- The verifier cannot insert directly. This procedure derives all payment terms from
-- immutable operation and reservation records and serializes on the operation row.
CREATE FUNCTION "b24_record_local_receipt"(kind TEXT, oid UUID, tx TEXT, block_hash TEXT, block_number BIGINT, log_index INTEGER)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE op RECORD; last_event RECORD; evidence_id UUID := gen_random_uuid();
BEGIN
 IF session_user<>'b24_receipt_verifier' OR current_database()<>'b22_disposable_review' OR NOT EXISTS(SELECT 1 FROM b22_guard.marker WHERE value='b22-isolated-test-only') THEN RAISE EXCEPTION 'receipt verifier not authorized' USING ERRCODE='42501'; END IF;
 IF kind='FUNDING' THEN
  SELECT f.id,f."sessionId",f."amountBaseUnits",r."buyerAddress",d."tokenAddress",d."contractAddress",d.status,d."chainId" INTO op FROM public."B24FundingOperation" f JOIN public."B24AuthorizationReservation" r ON r.id=f."reservationId" JOIN public."B24Deployment" d ON d.id=r."deploymentId" WHERE f.id=oid FOR UPDATE OF f;
  SELECT * INTO last_event FROM public."B24OperationEvent" WHERE "fundingOperationId"=oid ORDER BY sequence DESC LIMIT 1;
 ELSIF kind='ALLOWANCE' THEN
  SELECT a.id,a."sessionId",a."amountBaseUnits",r."buyerAddress",d."tokenAddress",d."contractAddress",d.status,d."chainId" INTO op FROM public."B24AllowanceOperation" a JOIN public."B24AuthorizationReservation" r ON r.id=a."reservationId" JOIN public."B24Deployment" d ON d.id=r."deploymentId" WHERE a.id=oid FOR UPDATE OF a;
  SELECT * INTO last_event FROM public."B24OperationEvent" WHERE "allowanceOperationId"=oid ORDER BY sequence DESC LIMIT 1;
 ELSE RAISE EXCEPTION 'unknown operation type'; END IF;
 IF op.id IS NULL OR op.status<>'TEST_FIXTURE' OR op."chainId"<>31337 OR last_event.state IS DISTINCT FROM 'SUBMITTED' OR last_event."txHash" IS DISTINCT FROM tx THEN RAISE EXCEPTION 'receipt operation context invalid'; END IF;
 INSERT INTO public."B24ReceiptEvidence"(id,"fundingOperationId","allowanceOperationId","txHash","blockHash","blockNumber","logIndex","sessionId","tokenAddress","buyerAddress","spenderAddress","amountBaseUnits","verifiedBy")
 VALUES(evidence_id,CASE WHEN kind='FUNDING' THEN oid END,CASE WHEN kind='ALLOWANCE' THEN oid END,tx,block_hash,block_number,log_index,op."sessionId",op."tokenAddress",op."buyerAddress",CASE WHEN kind='ALLOWANCE' THEN op."contractAddress" END,op."amountBaseUnits",session_user);
 INSERT INTO public."B24OperationEvent"(id,"fundingOperationId","allowanceOperationId",sequence,state,actor,"txHash")
 VALUES(gen_random_uuid(),CASE WHEN kind='FUNDING' THEN oid END,CASE WHEN kind='ALLOWANCE' THEN oid END,last_event.sequence+1,'VERIFIED',session_user,tx);
 RETURN evidence_id;
END $$;
REVOKE ALL ON FUNCTION "b24_record_local_receipt"(TEXT,UUID,TEXT,TEXT,BIGINT,INTEGER) FROM PUBLIC;

CREATE OR REPLACE FUNCTION "b24_draft_event_guard"() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE previous_state text; previous_sequence integer; operation_state text;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'B24 operation events are append-only'; END IF;
 NEW.actor:=session_user;
 IF NEW."signingOperationId" IS NOT NULL THEN
  SELECT state INTO operation_state FROM public."B24SigningOperation" WHERE id=NEW."signingOperationId" FOR UPDATE;
  SELECT state,sequence INTO previous_state,previous_sequence FROM public."B24OperationEvent" WHERE "signingOperationId"=NEW."signingOperationId" ORDER BY sequence DESC LIMIT 1;
 ELSIF NEW."fundingOperationId" IS NOT NULL THEN
  SELECT state INTO operation_state FROM public."B24FundingOperation" WHERE id=NEW."fundingOperationId" FOR UPDATE;
  SELECT state,sequence INTO previous_state,previous_sequence FROM public."B24OperationEvent" WHERE "fundingOperationId"=NEW."fundingOperationId" ORDER BY sequence DESC LIMIT 1;
 ELSE
  SELECT state INTO operation_state FROM public."B24AllowanceOperation" WHERE id=NEW."allowanceOperationId" FOR UPDATE;
  SELECT state,sequence INTO previous_state,previous_sequence FROM public."B24OperationEvent" WHERE "allowanceOperationId"=NEW."allowanceOperationId" ORDER BY sequence DESC LIMIT 1;
 END IF;
 IF operation_state IS NULL THEN RAISE EXCEPTION 'B24 operation not found'; END IF;
 IF NEW.sequence<>coalesce(previous_sequence,0)+1 THEN RAISE EXCEPTION 'B24 event sequence invalid'; END IF;
 previous_state:=coalesce(previous_state,operation_state);
 IF NEW."signingOperationId" IS NOT NULL THEN
  IF NEW."txHash" IS NOT NULL THEN RAISE EXCEPTION 'B24 signing event cannot have transaction hash'; END IF;
  IF previous_state='REQUESTED' AND NEW.state='AUTHORIZED' THEN
   IF session_user<>'b24_signer' THEN RAISE EXCEPTION 'signing actor invalid' USING ERRCODE='42501'; END IF;
   PERFORM public."b24_sign_lock"((SELECT "reservationId" FROM public."B24SigningOperation" WHERE id=NEW."signingOperationId"));
  ELSIF previous_state='AUTHORIZED' AND NEW.state='SIGNED' THEN
   IF session_user<>'b24_signer' OR NOT EXISTS(SELECT 1 FROM public."B24SignedAuthorization" WHERE "operationId"=NEW."signingOperationId") THEN RAISE EXCEPTION 'signed evidence missing'; END IF;
  ELSIF NOT (previous_state='REQUESTED' AND NEW.state IN ('BLOCKED','FAILED','UNRESOLVED')) THEN RAISE EXCEPTION 'B24 signing transition not enabled'; END IF;
 ELSE
  IF previous_state='SUBMITTED' AND NEW.state='VERIFIED' THEN
   IF session_user<>'b24_receipt_verifier' OR NOT EXISTS(SELECT 1 FROM public."B24ReceiptEvidence" e WHERE e."txHash"=NEW."txHash" AND ((e."fundingOperationId"=NEW."fundingOperationId" AND NEW."fundingOperationId" IS NOT NULL) OR (e."allowanceOperationId"=NEW."allowanceOperationId" AND NEW."allowanceOperationId" IS NOT NULL))) THEN RAISE EXCEPTION 'verified receipt evidence missing' USING ERRCODE='42501'; END IF;
  ELSIF NOT ((previous_state='PREPARED' AND NEW.state IN ('SUBMITTED','FAILED','UNRESOLVED')) OR (previous_state='SUBMITTED' AND NEW.state IN ('FAILED','UNRESOLVED'))) THEN RAISE EXCEPTION 'B24 transaction transition not enabled'; END IF;
  IF NEW.state='SUBMITTED' AND NEW."txHash" IS NULL THEN RAISE EXCEPTION 'B24 submitted transaction requires hash'; END IF;
 END IF;
 RETURN NEW;
END $$;
