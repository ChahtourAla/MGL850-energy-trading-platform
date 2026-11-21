CREATE TABLE "B24AllowanceSubmission" (
 "operationId" UUID PRIMARY KEY REFERENCES "B24AllowanceOperation"(id) ON DELETE RESTRICT,
 "reservationId" UUID NOT NULL REFERENCES "B24AuthorizationReservation"(id) ON DELETE RESTRICT,
 "sessionId" UUID NOT NULL REFERENCES "B24LocalChainSession"(id) ON DELETE RESTRICT,
 "senderNonce" BIGINT NOT NULL CHECK ("senderNonce">=0),
 "targetAmount" BIGINT NOT NULL CHECK ("targetAmount">=0),
 UNIQUE ("reservationId","targetAmount"), UNIQUE ("sessionId","senderNonce")
);
CREATE TRIGGER "B24AllowanceSubmission_immutable" BEFORE UPDATE OR DELETE ON "B24AllowanceSubmission" FOR EACH ROW EXECUTE FUNCTION "b24_draft_journal_immutable"();
REVOKE ALL ON "B24AllowanceSubmission" FROM PUBLIC;

CREATE FUNCTION "b24_prepare_local_allowance"(rid UUID,sid UUID,proposed_nonce BIGINT,target_amount BIGINT)
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
  RETURN to_jsonb(existing)||jsonb_build_object('reused',true);
 END IF;
 IF s.status<>'ACTIVE' OR proposed_nonce<0 OR target_amount NOT IN (0,r."amountBaseUnits") OR (target_amount>0 AND (p.status<>'ACTIVE' OR d.status<>'TEST_FIXTURE' OR clock_timestamp()<p."effectiveAt" OR clock_timestamp()>=p."expiresAt" OR clock_timestamp()>=r.deadline)) OR (target_amount=0 AND d.status NOT IN ('TEST_FIXTURE','RETIRED')) THEN RAISE EXCEPTION 'allowance authorization invalid'; END IF;
 IF EXISTS(SELECT 1 FROM public."B24AllowanceSubmission" x LEFT JOIN LATERAL (SELECT state FROM public."B24OperationEvent" WHERE "allowanceOperationId"=x."operationId" ORDER BY sequence DESC LIMIT 1) e ON true WHERE x."reservationId"=rid AND coalesce(e.state,'PREPARED') IN ('PREPARED','SUBMITTED','UNRESOLVED')) THEN RAISE EXCEPTION 'allowance operation unresolved'; END IF;
 INSERT INTO public."B24AllowanceOperation"(id,"reservationId","idempotencyKey",principal,"amountBaseUnits","sessionId") VALUES(oid,rid,'local-allowance:'||rid::text||':'||target_amount::text,session_user,target_amount,sid::text);
 INSERT INTO public."B24AllowanceSubmission"("operationId","reservationId","sessionId","senderNonce","targetAmount") VALUES(oid,rid,sid,proposed_nonce,target_amount);
 RETURN jsonb_build_object('id',oid,'amountBaseUnits',target_amount::text,'sessionId',sid,'senderNonce',proposed_nonce::text,'reused',false,'state',NULL,'txHash',NULL);
END $$;

CREATE FUNCTION "b24_lock_local_allowance"(oid UUID) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE op RECORD;
BEGIN
 IF session_user<>'b24_allowance' OR current_database()<>'b22_disposable_review' OR NOT EXISTS(SELECT 1 FROM b22_guard.marker WHERE value='b22-isolated-test-only') THEN RAISE EXCEPTION 'allowance role not authorized' USING ERRCODE='42501'; END IF;
 SELECT r.id reservation_id,r."buyerAddress",d."tokenAddress",d."contractAddress",s.id session_id,x."senderNonce",x."targetAmount",s.status session_status,p.status policy_status,p."effectiveAt",p."expiresAt",r.deadline,d.status deployment_status INTO op
 FROM public."B24AllowanceSubmission" x JOIN public."B24AllowanceOperation" a ON a.id=x."operationId" JOIN public."B24LocalChainSession" s ON s.id=x."sessionId" JOIN public."B24AuthorizationReservation" r ON r.id=x."reservationId" JOIN public."B24SpendingPolicy" p ON p.id=r."policyId" JOIN public."B24Deployment" d ON d.id=r."deploymentId" WHERE x."operationId"=oid FOR UPDATE OF a,s,p,d;
 IF op.session_status IS DISTINCT FROM 'ACTIVE' OR (op."targetAmount">0 AND (op.policy_status<>'ACTIVE' OR op.deployment_status<>'TEST_FIXTURE' OR clock_timestamp()<op."effectiveAt" OR clock_timestamp()>=op."expiresAt" OR clock_timestamp()>=op.deadline)) OR (op."targetAmount"=0 AND op.deployment_status NOT IN ('TEST_FIXTURE','RETIRED')) OR EXISTS(SELECT 1 FROM public."B24OperationEvent" WHERE "allowanceOperationId"=oid) THEN RAISE EXCEPTION 'allowance authorization invalid'; END IF;
 RETURN (to_jsonb(op)-'senderNonce'-'targetAmount')||jsonb_build_object('senderNonce',op."senderNonce"::text,'targetAmount',op."targetAmount"::text);
END $$;

CREATE FUNCTION "b24_submit_local_allowance"(oid UUID,tx TEXT) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e RECORD;
BEGIN
 IF session_user<>'b24_allowance' OR current_database()<>'b22_disposable_review' OR NOT EXISTS(SELECT 1 FROM b22_guard.marker WHERE value='b22-isolated-test-only') THEN RAISE EXCEPTION 'allowance role not authorized' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public."B24AllowanceOperation" WHERE id=oid FOR UPDATE;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public."B24AllowanceSubmission" WHERE "operationId"=oid) THEN RAISE EXCEPTION 'allowance operation missing'; END IF;
 SELECT state,"txHash" INTO e FROM public."B24OperationEvent" WHERE "allowanceOperationId"=oid ORDER BY sequence DESC LIMIT 1;
 IF e.state='SUBMITTED' AND e."txHash"=tx THEN RETURN; END IF;
 IF e.state IS NOT NULL THEN RAISE EXCEPTION 'allowance submission conflict'; END IF;
 INSERT INTO public."B24OperationEvent"(id,"allowanceOperationId",sequence,state,actor,"txHash") VALUES(gen_random_uuid(),oid,1,'SUBMITTED',session_user,tx);
END $$;
REVOKE ALL ON FUNCTION "b24_prepare_local_allowance"(UUID,UUID,BIGINT,BIGINT),"b24_lock_local_allowance"(UUID),"b24_submit_local_allowance"(UUID,TEXT) FROM PUBLIC;
