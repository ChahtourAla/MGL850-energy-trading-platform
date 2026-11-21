CREATE OR REPLACE FUNCTION "b24_draft_event_guard"() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
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
 IF NEW."signingOperationId" IS NOT NULL THEN
  IF NEW."txHash" IS NOT NULL THEN RAISE EXCEPTION 'B24 signing event cannot have transaction hash'; END IF;
  IF previous_state='REQUESTED' AND NEW."state"='AUTHORIZED' THEN
   IF session_user<>'b24_signer' THEN RAISE EXCEPTION 'signing actor invalid' USING ERRCODE='42501'; END IF;
   PERFORM public."b24_sign_lock"((SELECT "reservationId" FROM public."B24SigningOperation" WHERE id=NEW."signingOperationId"));
  ELSEIF previous_state='AUTHORIZED' AND NEW."state"='SIGNED' THEN
   IF session_user<>'b24_signer' OR NOT EXISTS(SELECT 1 FROM public."B24SignedAuthorization" WHERE "operationId"=NEW."signingOperationId") THEN RAISE EXCEPTION 'signed evidence missing'; END IF;
  ELSEIF NOT (previous_state='REQUESTED' AND NEW."state" IN ('BLOCKED','FAILED','UNRESOLVED')) THEN RAISE EXCEPTION 'B24 signing transition not enabled'; END IF;
 ELSE
  IF NOT ((previous_state='PREPARED' AND NEW."state" IN ('SUBMITTED','FAILED','UNRESOLVED')) OR (previous_state='SUBMITTED' AND NEW."state" IN ('FAILED','UNRESOLVED'))) THEN RAISE EXCEPTION 'B24 transaction transition not enabled'; END IF;
  IF NEW."state"='SUBMITTED' AND NEW."txHash" IS NULL THEN RAISE EXCEPTION 'B24 submitted transaction requires hash'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION "b24_sign_record"(rid UUID, oid UUID, sig TEXT, digest TEXT) RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public."B24AuthorizationReservation"%ROWTYPE; existing public."B24SignedAuthorization"%ROWTYPE;
BEGIN
 IF session_user<>'b24_signer' THEN RAISE EXCEPTION 'signer not authorized' USING ERRCODE='42501'; END IF;
 PERFORM public."b24_sign_lock"(rid);
 SELECT * INTO r FROM public."B24AuthorizationReservation" WHERE id=rid;
 IF digest<>r."settlementId" OR sig !~ '^0x[0-9a-f]{130}$' THEN RAISE EXCEPTION 'invalid signing result'; END IF;
 SELECT * INTO existing FROM public."B24SignedAuthorization" WHERE "reservationId"=rid;
 IF existing."reservationId" IS NOT NULL THEN
  IF existing."settlementId"<>digest THEN RAISE EXCEPTION 'conflicting signing result'; END IF;
  RETURN existing."signature";
 END IF;
 INSERT INTO public."B24SigningOperation"(id,"reservationId","idempotencyKey",principal) VALUES(oid,rid,rid::text,session_user);
 INSERT INTO public."B24OperationEvent"(id,"signingOperationId",sequence,state,actor) VALUES(gen_random_uuid(),oid,1,'AUTHORIZED',session_user);
 INSERT INTO public."B24SignedAuthorization"("reservationId","operationId","settlementId","buyerAddress",signature) VALUES(rid,oid,digest,r."buyerAddress",sig);
 INSERT INTO public."B24OperationEvent"(id,"signingOperationId",sequence,state,actor) VALUES(gen_random_uuid(),oid,2,'SIGNED',session_user);
 RETURN sig;
END $$;
