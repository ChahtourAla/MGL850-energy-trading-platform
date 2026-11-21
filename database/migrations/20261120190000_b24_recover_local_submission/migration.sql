-- Attach an independently located local transaction to an uncertain operation.
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
  IF previous_state IN ('SUBMITTED','UNRESOLVED') AND NEW.state='VERIFIED' THEN
   IF session_user<>'b24_receipt_verifier' OR NOT EXISTS(SELECT 1 FROM public."B24ReceiptEvidence" e WHERE e."txHash"=NEW."txHash" AND ((e."fundingOperationId"=NEW."fundingOperationId" AND NEW."fundingOperationId" IS NOT NULL) OR (e."allowanceOperationId"=NEW."allowanceOperationId" AND NEW."allowanceOperationId" IS NOT NULL))) THEN RAISE EXCEPTION 'verified receipt evidence missing' USING ERRCODE='42501'; END IF;
  ELSIF previous_state='UNRESOLVED' AND NEW.state='SUBMITTED' THEN
   IF NOT ((NEW."fundingOperationId" IS NOT NULL AND session_user='b24_funder') OR (NEW."allowanceOperationId" IS NOT NULL AND session_user='b24_allowance')) THEN RAISE EXCEPTION 'recovery actor invalid' USING ERRCODE='42501'; END IF;
   IF NEW."txHash" IS NULL THEN RAISE EXCEPTION 'recovered transaction requires hash'; END IF;
  ELSIF NOT ((previous_state='PREPARED' AND NEW.state IN ('SUBMITTED','FAILED','UNRESOLVED')) OR (previous_state='SUBMITTED' AND NEW.state IN ('FAILED','UNRESOLVED'))) THEN RAISE EXCEPTION 'B24 transaction transition not enabled'; END IF;
  IF NEW.state='SUBMITTED' AND NEW."txHash" IS NULL THEN RAISE EXCEPTION 'B24 submitted transaction requires hash'; END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION "b24_attach_local_submission"(kind TEXT,oid UUID,tx TEXT) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE previous RECORD;
BEGIN
 IF current_database()<>'b22_disposable_review' OR NOT EXISTS(SELECT 1 FROM b22_guard.marker WHERE value='b22-isolated-test-only') OR NOT ((kind='FUNDING' AND session_user='b24_funder') OR (kind='ALLOWANCE' AND session_user='b24_allowance')) THEN RAISE EXCEPTION 'recovery actor not authorized' USING ERRCODE='42501'; END IF;
 IF kind='FUNDING' THEN
  PERFORM 1 FROM public."B24FundingOperation" WHERE id=oid FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public."B24FundingSubmission" WHERE "operationId"=oid) THEN RAISE EXCEPTION 'funding operation missing'; END IF;
  SELECT state,sequence,"txHash" INTO previous FROM public."B24OperationEvent" WHERE "fundingOperationId"=oid ORDER BY sequence DESC LIMIT 1;
 ELSE
  PERFORM 1 FROM public."B24AllowanceOperation" WHERE id=oid FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public."B24AllowanceSubmission" WHERE "operationId"=oid) THEN RAISE EXCEPTION 'allowance operation missing'; END IF;
  SELECT state,sequence,"txHash" INTO previous FROM public."B24OperationEvent" WHERE "allowanceOperationId"=oid ORDER BY sequence DESC LIMIT 1;
 END IF;
 IF previous.state='SUBMITTED' AND previous."txHash"=tx THEN RETURN; END IF;
 IF previous.state IS DISTINCT FROM 'UNRESOLVED' OR previous."txHash" IS NOT NULL OR tx !~ '^0x[0-9a-f]{64}$' THEN RAISE EXCEPTION 'uncertain transaction context invalid'; END IF;
 INSERT INTO public."B24OperationEvent"(id,"fundingOperationId","allowanceOperationId",sequence,state,actor,"txHash",reason)
 VALUES(gen_random_uuid(),CASE WHEN kind='FUNDING' THEN oid END,CASE WHEN kind='ALLOWANCE' THEN oid END,previous.sequence+1,'SUBMITTED',session_user,tx,'located by sender and nonce on approved local chain');
END $$;
REVOKE ALL ON FUNCTION "b24_attach_local_submission"(TEXT,UUID,TEXT) FROM PUBLIC;
