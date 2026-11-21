-- Serialize the final local funding decision against grant/policy revocation.
CREATE FUNCTION "b24_lock_local_funding"(oid UUID) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE op RECORD;
BEGIN
 IF session_user<>'b24_funder' OR current_database()<>'b22_disposable_review' OR NOT EXISTS(SELECT 1 FROM b22_guard.marker WHERE value='b22-isolated-test-only') THEN RAISE EXCEPTION 'funding role not authorized' USING ERRCODE='42501'; END IF;
 SELECT g.status grant_status,s.status session_status,p.status policy_status,p."effectiveAt",p."expiresAt",r.deadline,d.status deployment_status INTO op
 FROM public."B24FundingSubmission" x JOIN public."B24FundingOperation" f ON f.id=x."operationId" JOIN public."B24LocalFundingGrant" g ON g.id=x."grantId" JOIN public."B24LocalChainSession" s ON s.id=x."sessionId" JOIN public."B24AuthorizationReservation" r ON r.id=x."reservationId" JOIN public."B24SpendingPolicy" p ON p.id=r."policyId" JOIN public."B24Deployment" d ON d.id=r."deploymentId"
 WHERE x."operationId"=oid FOR UPDATE OF f,g,s,p,d;
 IF op.grant_status IS DISTINCT FROM 'ACTIVE' OR op.session_status IS DISTINCT FROM 'ACTIVE' OR op.policy_status IS DISTINCT FROM 'ACTIVE' OR op.deployment_status IS DISTINCT FROM 'TEST_FIXTURE' OR clock_timestamp()<op."effectiveAt" OR clock_timestamp()>=op."expiresAt" OR clock_timestamp()>=op.deadline OR EXISTS(SELECT 1 FROM public."B24OperationEvent" WHERE "fundingOperationId"=oid) THEN RAISE EXCEPTION 'funding authorization invalid'; END IF;
END $$;
REVOKE ALL ON FUNCTION "b24_lock_local_funding"(UUID) FROM PUBLIC;
