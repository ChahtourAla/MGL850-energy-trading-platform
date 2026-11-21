-- Local test-only funding grants and immutable pre-submission identities.
CREATE TABLE "B24LocalFundingGrant" (
 id UUID PRIMARY KEY, "sessionId" UUID NOT NULL REFERENCES "B24LocalChainSession"(id) ON DELETE RESTRICT,
 "minterAddress" VARCHAR(42) NOT NULL CHECK ("minterAddress" ~ '^0x[0-9a-f]{40}$'),
 "perOperationLimit" BIGINT NOT NULL CHECK ("perOperationLimit">0),
 "cumulativeLimit" BIGINT NOT NULL CHECK ("cumulativeLimit">=0),
 status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
 "approvedBy" VARCHAR(128) NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "B24FundingSubmission" (
 "operationId" UUID PRIMARY KEY REFERENCES "B24FundingOperation"(id) ON DELETE RESTRICT,
 "reservationId" UUID NOT NULL UNIQUE REFERENCES "B24AuthorizationReservation"(id) ON DELETE RESTRICT,
 "grantId" UUID NOT NULL REFERENCES "B24LocalFundingGrant"(id) ON DELETE RESTRICT,
 "sessionId" UUID NOT NULL REFERENCES "B24LocalChainSession"(id) ON DELETE RESTRICT,
 "senderAddress" VARCHAR(42) NOT NULL CHECK ("senderAddress" ~ '^0x[0-9a-f]{40}$'),
 "senderNonce" BIGINT NOT NULL CHECK ("senderNonce">=0),
 UNIQUE ("sessionId","senderAddress","senderNonce")
);
CREATE TRIGGER "B24FundingSubmission_immutable" BEFORE UPDATE OR DELETE ON "B24FundingSubmission" FOR EACH ROW EXECUTE FUNCTION "b24_draft_journal_immutable"();
CREATE FUNCTION "b24_local_funding_grant_guard"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'funding grant immutable'; END IF;
 IF session_user<>'b24_approver' OR current_database()<>'b22_disposable_review' OR NOT EXISTS(SELECT 1 FROM b22_guard.marker WHERE value='b22-isolated-test-only') THEN RAISE EXCEPTION 'funding approver not authorized' USING ERRCODE='42501'; END IF;
 IF TG_OP='INSERT' THEN
  NEW."approvedBy":=session_user;
  IF NOT EXISTS(SELECT 1 FROM "B24LocalChainSession" WHERE id=NEW."sessionId" AND status='ACTIVE') THEN RAISE EXCEPTION 'funding session invalid'; END IF;
 ELSIF (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') OR OLD.status<>'ACTIVE' OR NEW.status<>'REVOKED' THEN RAISE EXCEPTION 'funding grant immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "B24LocalFundingGrant_guard" BEFORE INSERT OR UPDATE OR DELETE ON "B24LocalFundingGrant" FOR EACH ROW EXECUTE FUNCTION "b24_local_funding_grant_guard"();
REVOKE ALL ON "B24LocalFundingGrant","B24FundingSubmission" FROM PUBLIC;

CREATE FUNCTION "b24_prepare_local_funding"(rid UUID,gid UUID,proposed_nonce BIGINT,proposed_amount BIGINT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE g public."B24LocalFundingGrant"%ROWTYPE; s public."B24LocalChainSession"%ROWTYPE; r public."B24AuthorizationReservation"%ROWTYPE; p public."B24SpendingPolicy"%ROWTYPE; d public."B24Deployment"%ROWTYPE; existing RECORD; used NUMERIC; oid UUID:=gen_random_uuid();
BEGIN
 IF session_user<>'b24_funder' OR current_database()<>'b22_disposable_review' OR NOT EXISTS(SELECT 1 FROM b22_guard.marker WHERE value='b22-isolated-test-only') THEN RAISE EXCEPTION 'funding role not authorized' USING ERRCODE='42501'; END IF;
 SELECT * INTO g FROM public."B24LocalFundingGrant" WHERE id=gid FOR UPDATE;
 SELECT * INTO r FROM public."B24AuthorizationReservation" WHERE id=rid;
 IF g.id IS NULL OR r.id IS NULL THEN RAISE EXCEPTION 'funding grant or reservation missing'; END IF;
 SELECT * INTO s FROM public."B24LocalChainSession" WHERE id=g."sessionId" FOR UPDATE;
 SELECT * INTO p FROM public."B24SpendingPolicy" WHERE id=r."policyId" FOR UPDATE;
 SELECT * INTO d FROM public."B24Deployment" WHERE id=r."deploymentId" FOR UPDATE;
 SELECT f.id,f."amountBaseUnits",f."sessionId",x."senderAddress",x."senderNonce",x."grantId",e.state,e."txHash" INTO existing FROM public."B24FundingSubmission" x JOIN public."B24FundingOperation" f ON f.id=x."operationId" LEFT JOIN LATERAL (SELECT state,"txHash" FROM public."B24OperationEvent" WHERE "fundingOperationId"=f.id ORDER BY sequence DESC LIMIT 1) e ON true WHERE x."reservationId"=rid;
 IF existing.id IS NOT NULL THEN
  IF existing."grantId"<>gid THEN RAISE EXCEPTION 'conflicting funding grant'; END IF;
  RETURN to_jsonb(existing)||jsonb_build_object('reused',true);
 END IF;
 IF g.status<>'ACTIVE' OR s.status<>'ACTIVE' OR s."reservationId"<>rid OR s."deploymentId"<>d.id OR d.status<>'TEST_FIXTURE' OR p.status<>'ACTIVE' OR p."consentKind"<>'SIMULATED_TEST' OR clock_timestamp()<p."effectiveAt" OR clock_timestamp()>=p."expiresAt" OR clock_timestamp()>=r.deadline THEN RAISE EXCEPTION 'funding authorization invalid'; END IF;
 IF proposed_nonce<0 OR proposed_amount<=0 OR proposed_amount>r."amountBaseUnits" OR proposed_amount>g."perOperationLimit" THEN RAISE EXCEPTION 'funding amount or nonce invalid'; END IF;
 SELECT coalesce(sum(f."amountBaseUnits"),0) INTO used FROM public."B24FundingSubmission" x JOIN public."B24FundingOperation" f ON f.id=x."operationId" WHERE x."grantId"=gid;
 IF used+proposed_amount>g."cumulativeLimit" THEN RAISE EXCEPTION 'funding budget exceeded'; END IF;
 INSERT INTO public."B24FundingOperation"(id,"reservationId","idempotencyKey",principal,"amountBaseUnits","sessionId") VALUES(oid,rid,'local-funding:'||rid::text,session_user,proposed_amount,s.id::text);
 INSERT INTO public."B24FundingSubmission"("operationId","reservationId","grantId","sessionId","senderAddress","senderNonce") VALUES(oid,rid,gid,s.id,g."minterAddress",proposed_nonce);
 RETURN jsonb_build_object('id',oid,'amountBaseUnits',proposed_amount::text,'sessionId',s.id,'senderAddress',g."minterAddress",'senderNonce',proposed_nonce::text,'grantId',gid,'reused',false,'state',NULL,'txHash',NULL);
END $$;

CREATE FUNCTION "b24_submit_local_funding"(oid UUID,tx TEXT) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e RECORD;
BEGIN
 IF session_user<>'b24_funder' OR current_database()<>'b22_disposable_review' OR NOT EXISTS(SELECT 1 FROM b22_guard.marker WHERE value='b22-isolated-test-only') THEN RAISE EXCEPTION 'funding role not authorized' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public."B24FundingOperation" WHERE id=oid FOR UPDATE;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public."B24FundingSubmission" WHERE "operationId"=oid) THEN RAISE EXCEPTION 'funding operation missing'; END IF;
 SELECT state,"txHash" INTO e FROM public."B24OperationEvent" WHERE "fundingOperationId"=oid ORDER BY sequence DESC LIMIT 1;
 IF e.state='SUBMITTED' AND e."txHash"=tx THEN RETURN; END IF;
 IF e.state IS NOT NULL THEN RAISE EXCEPTION 'funding submission conflict'; END IF;
 INSERT INTO public."B24OperationEvent"(id,"fundingOperationId",sequence,state,actor,"txHash") VALUES(gen_random_uuid(),oid,1,'SUBMITTED',session_user,tx);
END $$;
REVOKE ALL ON FUNCTION "b24_prepare_local_funding"(UUID,UUID,BIGINT,BIGINT),"b24_submit_local_funding"(UUID,TEXT) FROM PUBLIC;
