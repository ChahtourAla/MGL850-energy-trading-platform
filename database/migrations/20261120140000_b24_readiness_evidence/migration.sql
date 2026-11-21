CREATE FUNCTION "b24_local_readiness_evidence"(rid UUID,sid UUID) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public."B24AuthorizationReservation"%ROWTYPE; p public."B24SpendingPolicy"%ROWTYPE; d public."B24Deployment"%ROWTYPE; sig TEXT; funding_ok BOOLEAN; allowance_ok BOOLEAN; unresolved BOOLEAN;
BEGIN
 IF session_user<>'b24_preflight' OR current_database()<>'b22_disposable_review' OR NOT EXISTS(SELECT 1 FROM b22_guard.marker WHERE value='b22-isolated-test-only') THEN RAISE EXCEPTION 'readiness role not authorized' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM public."B24AuthorizationReservation" WHERE id=rid;
 SELECT * INTO p FROM public."B24SpendingPolicy" WHERE id=r."policyId";
 SELECT * INTO d FROM public."B24Deployment" WHERE id=r."deploymentId";
 IF r.id IS NULL OR p.status<>'ACTIVE' OR d.status<>'TEST_FIXTURE' OR clock_timestamp()<p."effectiveAt" OR clock_timestamp()>=p."expiresAt" OR clock_timestamp()>=r.deadline OR NOT EXISTS(SELECT 1 FROM public."B24LocalChainSession" WHERE id=sid AND "reservationId"=rid AND status='ACTIVE') THEN RETURN NULL; END IF;
 SELECT a.signature INTO sig FROM public."B24SignedAuthorization" a WHERE a."reservationId"=rid AND EXISTS(SELECT 1 FROM public."B24OperationEvent" e WHERE e."signingOperationId"=a."operationId" AND e.state='SIGNED');
 SELECT EXISTS(SELECT 1 FROM public."B24FundingSubmission" x JOIN public."B24ReceiptEvidence" e ON e."fundingOperationId"=x."operationId" JOIN public."B24OperationEvent" ev ON ev."fundingOperationId"=x."operationId" AND ev.state='VERIFIED' AND ev."txHash"=e."txHash" WHERE x."reservationId"=rid AND x."sessionId"=sid AND e."sessionId"=sid::text) INTO funding_ok;
 SELECT EXISTS(SELECT 1 FROM public."B24AllowanceSubmission" x JOIN public."B24ReceiptEvidence" e ON e."allowanceOperationId"=x."operationId" JOIN public."B24OperationEvent" ev ON ev."allowanceOperationId"=x."operationId" AND ev.state='VERIFIED' AND ev."txHash"=e."txHash" WHERE x."reservationId"=rid AND x."sessionId"=sid AND x."targetAmount"=r."amountBaseUnits" AND e."sessionId"=sid::text) INTO allowance_ok;
 SELECT EXISTS(SELECT 1 FROM public."B24FundingSubmission" x LEFT JOIN LATERAL (SELECT state FROM public."B24OperationEvent" WHERE "fundingOperationId"=x."operationId" ORDER BY sequence DESC LIMIT 1) e ON true WHERE x."reservationId"=rid AND coalesce(e.state,'PREPARED') IN ('PREPARED','SUBMITTED','UNRESOLVED')) OR EXISTS(SELECT 1 FROM public."B24AllowanceSubmission" x LEFT JOIN LATERAL (SELECT state FROM public."B24OperationEvent" WHERE "allowanceOperationId"=x."operationId" ORDER BY sequence DESC LIMIT 1) e ON true WHERE x."reservationId"=rid AND coalesce(e.state,'PREPARED') IN ('PREPARED','SUBMITTED','UNRESOLVED')) INTO unresolved;
 RETURN jsonb_build_object('signature',sig,'fundingVerified',funding_ok,'allowanceVerified',allowance_ok,'unresolved',unresolved);
END $$;
REVOKE ALL ON FUNCTION "b24_local_readiness_evidence"(UUID,UUID) FROM PUBLIC;
