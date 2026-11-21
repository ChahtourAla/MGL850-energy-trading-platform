-- Lock before reading the local balance, and refuse new shared-budget funding while another operation is unresolved.
CREATE FUNCTION "b24_lock_local_funding_budget"(gid UUID) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF session_user<>'b24_funder' OR current_database()<>'b22_disposable_review' OR NOT EXISTS(SELECT 1 FROM b22_guard.marker WHERE value='b22-isolated-test-only') THEN RAISE EXCEPTION 'funding role not authorized' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public."B24LocalFundingGrant" g JOIN public."B24LocalFundingBudgetGrant" binding ON binding."grantId"=g.id JOIN public."B24LocalFundingBudget" b ON b.id=binding."budgetId" WHERE g.id=gid AND g.status='ACTIVE' AND b.status='ACTIVE' FOR UPDATE OF g,b;
 IF NOT FOUND THEN RAISE EXCEPTION 'funding budget unavailable'; END IF;
END $$;
REVOKE ALL ON FUNCTION "b24_lock_local_funding_budget"(UUID) FROM PUBLIC;

CREATE OR REPLACE FUNCTION "b24_prepare_local_funding"(rid UUID,gid UUID,proposed_nonce BIGINT,proposed_amount BIGINT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE g public."B24LocalFundingGrant"%ROWTYPE; budget public."B24LocalFundingBudget"%ROWTYPE; s public."B24LocalChainSession"%ROWTYPE; r public."B24AuthorizationReservation"%ROWTYPE; p public."B24SpendingPolicy"%ROWTYPE; d public."B24Deployment"%ROWTYPE; existing RECORD; used NUMERIC; oid UUID:=gen_random_uuid();
BEGIN
 IF session_user<>'b24_funder' OR current_database()<>'b22_disposable_review' OR NOT EXISTS(SELECT 1 FROM b22_guard.marker WHERE value='b22-isolated-test-only') THEN RAISE EXCEPTION 'funding role not authorized' USING ERRCODE='42501'; END IF;
 SELECT * INTO g FROM public."B24LocalFundingGrant" WHERE id=gid FOR UPDATE;
 SELECT * INTO r FROM public."B24AuthorizationReservation" WHERE id=rid;
 IF g.id IS NULL OR r.id IS NULL THEN RAISE EXCEPTION 'funding grant or reservation missing'; END IF;
 SELECT b.* INTO budget FROM public."B24LocalFundingBudgetGrant" binding JOIN public."B24LocalFundingBudget" b ON b.id=binding."budgetId" WHERE binding."grantId"=gid FOR UPDATE OF b;
 IF budget.id IS NULL OR budget.status<>'ACTIVE' THEN RAISE EXCEPTION 'funding budget unavailable'; END IF;
 SELECT * INTO s FROM public."B24LocalChainSession" WHERE id=g."sessionId" FOR UPDATE;
 SELECT * INTO p FROM public."B24SpendingPolicy" WHERE id=r."policyId" FOR UPDATE;
 SELECT * INTO d FROM public."B24Deployment" WHERE id=r."deploymentId" FOR UPDATE;
 SELECT f.id,f."amountBaseUnits",f."sessionId",x."senderAddress",x."senderNonce",x."grantId",e.state,e."txHash" INTO existing FROM public."B24FundingSubmission" x JOIN public."B24FundingOperation" f ON f.id=x."operationId" LEFT JOIN LATERAL (SELECT state,"txHash" FROM public."B24OperationEvent" WHERE "fundingOperationId"=f.id ORDER BY sequence DESC LIMIT 1) e ON true WHERE x."reservationId"=rid;
 IF existing.id IS NOT NULL THEN
  IF existing."grantId"<>gid THEN RAISE EXCEPTION 'conflicting funding grant'; END IF;
  RETURN (to_jsonb(existing)-'amountBaseUnits'-'senderNonce')||jsonb_build_object('amountBaseUnits',existing."amountBaseUnits"::text,'senderNonce',existing."senderNonce"::text,'reused',true);
 END IF;
 IF EXISTS(SELECT 1 FROM public."B24FundingSubmission" x JOIN public."B24LocalFundingBudgetGrant" binding ON binding."grantId"=x."grantId" LEFT JOIN LATERAL (SELECT state FROM public."B24OperationEvent" WHERE "fundingOperationId"=x."operationId" ORDER BY sequence DESC LIMIT 1) e ON true WHERE binding."budgetId"=budget.id AND coalesce(e.state,'PREPARED')<>'VERIFIED') THEN RAISE EXCEPTION 'shared funding budget has unresolved operation'; END IF;
 IF g.status<>'ACTIVE' OR s.status<>'ACTIVE' OR s."reservationId"<>rid OR s."deploymentId"<>d.id OR d.status<>'TEST_FIXTURE' OR p.status<>'ACTIVE' OR p."consentKind"<>'SIMULATED_TEST' OR clock_timestamp()<p."effectiveAt" OR clock_timestamp()>=p."expiresAt" OR clock_timestamp()>=r.deadline THEN RAISE EXCEPTION 'funding authorization invalid'; END IF;
 IF proposed_nonce<0 OR proposed_amount<=0 OR proposed_amount>r."amountBaseUnits" OR proposed_amount>g."perOperationLimit" THEN RAISE EXCEPTION 'funding amount or nonce invalid'; END IF;
 SELECT coalesce(sum(f."amountBaseUnits"),0) INTO used FROM public."B24FundingSubmission" x JOIN public."B24FundingOperation" f ON f.id=x."operationId" WHERE x."grantId"=gid;
 IF used+proposed_amount>g."cumulativeLimit" THEN RAISE EXCEPTION 'funding budget exceeded'; END IF;
 SELECT coalesce(sum(f."amountBaseUnits"),0) INTO used FROM public."B24FundingSubmission" x JOIN public."B24FundingOperation" f ON f.id=x."operationId" JOIN public."B24LocalFundingBudgetGrant" binding ON binding."grantId"=x."grantId" WHERE binding."budgetId"=budget.id;
 IF used+proposed_amount>budget."cumulativeLimit" THEN RAISE EXCEPTION 'shared funding budget exceeded'; END IF;
 INSERT INTO public."B24FundingOperation"(id,"reservationId","idempotencyKey",principal,"amountBaseUnits","sessionId") VALUES(oid,rid,'local-funding:'||rid::text,session_user,proposed_amount,s.id::text);
 INSERT INTO public."B24FundingSubmission"("operationId","reservationId","grantId","sessionId","senderAddress","senderNonce") VALUES(oid,rid,gid,s.id,g."minterAddress",proposed_nonce);
 RETURN jsonb_build_object('id',oid,'amountBaseUnits',proposed_amount::text,'sessionId',s.id,'senderAddress',g."minterAddress",'senderNonce',proposed_nonce::text,'grantId',gid,'reused',false,'state',NULL,'txHash',NULL);
END $$;
