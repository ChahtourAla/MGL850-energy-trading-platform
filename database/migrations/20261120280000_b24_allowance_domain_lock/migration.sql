-- One ERC-20 allowance domain spans all of a buyer's reservations.
CREATE OR REPLACE FUNCTION "b24_prepare_local_allowance"(rid UUID,sid UUID,proposed_nonce BIGINT,target_amount BIGINT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public."B24LocalChainSession"%ROWTYPE; r public."B24AuthorizationReservation"%ROWTYPE; p public."B24SpendingPolicy"%ROWTYPE; d public."B24Deployment"%ROWTYPE; existing RECORD; oid UUID:=gen_random_uuid();
BEGIN
 IF session_user<>'b24_allowance' OR current_database()<>'b22_disposable_review' OR NOT EXISTS(SELECT 1 FROM b22_guard.marker WHERE value='b22-isolated-test-only') THEN RAISE EXCEPTION 'allowance role not authorized' USING ERRCODE='42501'; END IF;
 SELECT * INTO s FROM public."B24LocalChainSession" WHERE id=sid FOR UPDATE;
 SELECT * INTO r FROM public."B24AuthorizationReservation" WHERE id=rid;
 IF s.id IS NULL OR r.id IS NULL OR s."reservationId"<>rid THEN RAISE EXCEPTION 'allowance session invalid'; END IF;
 SELECT * INTO p FROM public."B24SpendingPolicy" WHERE id=r."policyId" FOR UPDATE;
 SELECT * INTO d FROM public."B24Deployment" WHERE id=r."deploymentId" FOR UPDATE;
 SELECT a.id,a."amountBaseUnits",a."sessionId",x."senderNonce",e.state,e."txHash" INTO existing FROM public."B24AllowanceSubmission" x JOIN public."B24AllowanceOperation" a ON a.id=x."operationId" LEFT JOIN LATERAL (SELECT state,"txHash" FROM public."B24OperationEvent" WHERE "allowanceOperationId"=a.id ORDER BY sequence DESC LIMIT 1) e ON true WHERE x."reservationId"=rid AND x."targetAmount"=target_amount;
 IF existing.id IS NOT NULL THEN
  IF existing."sessionId"<>sid::text THEN RAISE EXCEPTION 'conflicting allowance session'; END IF;
  RETURN (to_jsonb(existing)-'amountBaseUnits'-'senderNonce')||jsonb_build_object('amountBaseUnits',existing."amountBaseUnits"::text,'senderNonce',existing."senderNonce"::text,'reused',true);
 END IF;
 IF s.status<>'ACTIVE' OR proposed_nonce<0 OR target_amount NOT IN (0,r."amountBaseUnits") OR (target_amount>0 AND (p.status<>'ACTIVE' OR d.status<>'TEST_FIXTURE' OR clock_timestamp()<p."effectiveAt" OR clock_timestamp()>=p."expiresAt" OR clock_timestamp()>=r.deadline)) OR (target_amount=0 AND d.status NOT IN ('TEST_FIXTURE','RETIRED')) THEN RAISE EXCEPTION 'allowance authorization invalid'; END IF;
 IF EXISTS(SELECT 1 FROM public."B24AllowanceSubmission" x LEFT JOIN LATERAL (SELECT state FROM public."B24OperationEvent" WHERE "allowanceOperationId"=x."operationId" ORDER BY sequence DESC LIMIT 1) e ON true JOIN public."B24AuthorizationReservation" other_r ON other_r.id=x."reservationId" JOIN public."B24Deployment" other_d ON other_d.id=other_r."deploymentId" WHERE other_r."buyerAddress"=r."buyerAddress" AND other_d."tokenAddress"=d."tokenAddress" AND other_d."contractAddress"=d."contractAddress" AND coalesce(e.state,'PREPARED') IN ('PREPARED','SUBMITTED','UNRESOLVED')) THEN RAISE EXCEPTION 'allowance operation unresolved'; END IF;
 INSERT INTO public."B24AllowanceOperation"(id,"reservationId","idempotencyKey",principal,"amountBaseUnits","sessionId") VALUES(oid,rid,'local-allowance:'||rid::text||':'||target_amount::text,session_user,target_amount,sid::text);
 INSERT INTO public."B24AllowanceSubmission"("operationId","reservationId","sessionId","senderNonce","targetAmount") VALUES(oid,rid,sid,proposed_nonce,target_amount);
 RETURN jsonb_build_object('id',oid,'amountBaseUnits',target_amount::text,'sessionId',sid,'senderNonce',proposed_nonce::text,'reused',false,'state',NULL,'txHash',NULL);
END $$;
