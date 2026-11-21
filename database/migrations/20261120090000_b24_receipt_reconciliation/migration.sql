-- Reconciliation of already-submitted local transactions remains possible after deployment retirement.
CREATE OR REPLACE FUNCTION "b24_record_local_receipt"(kind TEXT, oid UUID, tx TEXT, block_hash TEXT, block_number BIGINT, log_index INTEGER)
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
 IF op.id IS NULL OR op.status NOT IN ('TEST_FIXTURE','RETIRED') OR op."chainId"<>31337 OR last_event.state IS DISTINCT FROM 'SUBMITTED' OR last_event."txHash" IS DISTINCT FROM tx THEN RAISE EXCEPTION 'receipt operation context invalid'; END IF;
 INSERT INTO public."B24ReceiptEvidence"(id,"fundingOperationId","allowanceOperationId","txHash","blockHash","blockNumber","logIndex","sessionId","tokenAddress","buyerAddress","spenderAddress","amountBaseUnits","verifiedBy")
 VALUES(evidence_id,CASE WHEN kind='FUNDING' THEN oid END,CASE WHEN kind='ALLOWANCE' THEN oid END,tx,block_hash,block_number,log_index,op."sessionId",op."tokenAddress",op."buyerAddress",CASE WHEN kind='ALLOWANCE' THEN op."contractAddress" END,op."amountBaseUnits",session_user);
 INSERT INTO public."B24OperationEvent"(id,"fundingOperationId","allowanceOperationId",sequence,state,actor,"txHash")
 VALUES(gen_random_uuid(),CASE WHEN kind='FUNDING' THEN oid END,CASE WHEN kind='ALLOWANCE' THEN oid END,last_event.sequence+1,'VERIFIED',session_user,tx);
 RETURN evidence_id;
END $$;
