-- Local fixture support is limited to the named disposable database; chain 296 remains
-- the only permitted non-fixture chain. No accepted migration is modified.
ALTER TABLE "V2SettlementIntent" DROP CONSTRAINT "V2Intent_values_check";
ALTER TABLE "V2SettlementIntent" ADD CONSTRAINT "V2Intent_values_check" CHECK (("chainId"=296 OR ("chainId"=31337 AND current_database()='b22_disposable_review')) AND "amountBaseUnits">=0 AND status IN ('PLANNED','READY','SIGNED','SUBMITTED','CONFIRMED','PROJECTED','BLOCKED','REVERTED','UNKNOWN'));
ALTER TABLE "V2SettlementEvidence" DROP CONSTRAINT "V2Evidence_values_check";
ALTER TABLE "V2SettlementEvidence" ADD CONSTRAINT "V2Evidence_values_check" CHECK (("chainId"=296 OR ("chainId"=31337 AND current_database()='b22_disposable_review')) AND "logIndex">=0 AND "amountBaseUnits">=0 AND "receiptStatus" IN ('SUCCESS','FAILED') AND "verificationStatus" IN ('PENDING','VERIFIED','REJECTED') AND ("verificationStatus"<>'VERIFIED' OR "receiptStatus"='SUCCESS'));
CREATE TABLE "B25LocalIntentBinding" (
 "intentId" VARCHAR(66) PRIMARY KEY REFERENCES "V2SettlementIntent"(id) ON DELETE RESTRICT,
 "reservationId" UUID NOT NULL UNIQUE REFERENCES "B24AuthorizationReservation"(id) ON DELETE RESTRICT,
 "sessionId" UUID NOT NULL REFERENCES "B24LocalChainSession"(id) ON DELETE RESTRICT,
 "settlementDigest" VARCHAR(66) NOT NULL UNIQUE,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION "b25_immutable_binding"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'B25 intent binding is immutable'; END $$;
CREATE TRIGGER "B25Binding_immutable" BEFORE UPDATE OR DELETE ON "B25LocalIntentBinding" FOR EACH ROW EXECUTE FUNCTION "b25_immutable_binding"();
CREATE FUNCTION "b25_create_local_intent"(rid UUID,sid UUID,iid TEXT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public."B24AuthorizationReservation"%ROWTYPE; d public."B24Deployment"%ROWTYPE; p public."B24SpendingPolicy"%ROWTYPE; a public."V2Allocation"%ROWTYPE; old public."B25LocalIntentBinding"%ROWTYPE;
BEGIN
 IF session_user<>'b25_executor' OR current_database()<>'b22_disposable_review' OR NOT EXISTS(SELECT 1 FROM b22_guard.marker WHERE value='b22-isolated-test-only') THEN RAISE EXCEPTION 'B25 executor not authorized' USING ERRCODE='42501'; END IF;
 IF iid !~ '^0x[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Invalid fixture intent identity'; END IF;
 SELECT * INTO r FROM public."B24AuthorizationReservation" WHERE id=rid FOR UPDATE;
 SELECT * INTO d FROM public."B24Deployment" WHERE id=r."deploymentId" FOR SHARE;
 SELECT * INTO p FROM public."B24SpendingPolicy" WHERE id=r."policyId" FOR SHARE;
 SELECT * INTO a FROM public."V2Allocation" WHERE id=r."allocationId";
 IF r.id IS NULL OR r.status<>'RESERVED' OR d.status<>'TEST_FIXTURE' OR d."chainId"<>31337 OR p.status<>'ACTIVE' OR clock_timestamp()<p."effectiveAt" OR clock_timestamp()>=p."expiresAt" OR clock_timestamp()>=r.deadline OR a.status<>'VALIDATED' OR a."amountBaseUnits"<>r."amountBaseUnits" OR a."remainder"<>0 OR a."amountBaseUnits"<=0 OR NOT EXISTS(SELECT 1 FROM public."V2AllocationPlan" WHERE id=a."planId" AND status='AUTHORITATIVE') OR NOT EXISTS(SELECT 1 FROM public."B24SignedAuthorization" WHERE "reservationId"=rid AND "settlementId"=r."settlementId") OR NOT EXISTS(SELECT 1 FROM public."B24LocalChainSession" WHERE id=sid AND "reservationId"=rid AND status='ACTIVE') THEN RAISE EXCEPTION 'B25 reservation or authorization invalid'; END IF;
 SELECT * INTO old FROM public."B25LocalIntentBinding" WHERE "reservationId"=rid;
 IF FOUND THEN
  IF old."intentId"<>iid OR old."sessionId"<>sid OR old."settlementDigest"<>r."settlementId" THEN RAISE EXCEPTION 'Conflicting B25 intent'; END IF;
  RETURN jsonb_build_object('intentId',iid,'reused',true);
 END IF;
 INSERT INTO public."V2SettlementIntent"(id,"allocationId","marketId","chainId","tokenAddress","contractAddress","amountBaseUnits",status,"updatedAt") VALUES(iid,r."allocationId",r."marketId",31337,d."tokenAddress",d."contractAddress",r."amountBaseUnits",'PLANNED',clock_timestamp());
 INSERT INTO public."B25LocalIntentBinding"("intentId","reservationId","sessionId","settlementDigest") VALUES(iid,rid,sid,r."settlementId");
 RETURN jsonb_build_object('intentId',iid,'reused',false);
END $$;
REVOKE ALL ON FUNCTION "b25_create_local_intent"(UUID,UUID,TEXT) FROM PUBLIC;
CREATE TABLE "B25LocalAttempt" (
 id UUID PRIMARY KEY,
 "intentId" VARCHAR(66) NOT NULL UNIQUE REFERENCES "B25LocalIntentBinding"("intentId") ON DELETE RESTRICT,
 "sessionId" UUID NOT NULL REFERENCES "B24LocalChainSession"(id) ON DELETE RESTRICT,
 "operatorAddress" VARCHAR(42) NOT NULL CHECK ("operatorAddress" ~ '^0x[0-9a-f]{40}$'),
 "operatorNonce" BIGINT NOT NULL CHECK ("operatorNonce">=0),
 "transactionHash" VARCHAR(66) NOT NULL UNIQUE CHECK ("transactionHash" ~ '^0x[0-9a-f]{64}$'),
 "calldataHash" VARCHAR(66) NOT NULL CHECK ("calldataHash" ~ '^0x[0-9a-f]{64}$'),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
 UNIQUE ("operatorAddress","operatorNonce")
);
CREATE TRIGGER "B25Attempt_immutable" BEFORE UPDATE OR DELETE ON "B25LocalAttempt" FOR EACH ROW EXECUTE FUNCTION "b25_immutable_binding"();
CREATE FUNCTION "b25_local_context"(iid TEXT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE b public."B25LocalIntentBinding"%ROWTYPE; r public."B24AuthorizationReservation"%ROWTYPE; d public."B24Deployment"%ROWTYPE; s TEXT;
BEGIN
 IF session_user<>'b25_executor' OR current_database()<>'b22_disposable_review' OR NOT EXISTS(SELECT 1 FROM b22_guard.marker WHERE value='b22-isolated-test-only') THEN RAISE EXCEPTION 'B25 executor not authorized' USING ERRCODE='42501'; END IF;
 SELECT * INTO b FROM public."B25LocalIntentBinding" WHERE "intentId"=iid;
 SELECT * INTO r FROM public."B24AuthorizationReservation" WHERE id=b."reservationId";
 SELECT * INTO d FROM public."B24Deployment" WHERE id=r."deploymentId";
 SELECT signature INTO s FROM public."B24SignedAuthorization" WHERE "reservationId"=r.id AND "settlementId"=r."settlementId";
 IF b."intentId" IS NULL OR s IS NULL THEN RAISE EXCEPTION 'B25 intent missing'; END IF;
 RETURN jsonb_build_object('reservationId',r.id,'sessionId',b."sessionId",'buyerAddress',r."buyerAddress",'settlementId',r."settlementId",'terms',r.terms,'signature',s,'contractAddress',d."contractAddress",'tokenAddress',d."tokenAddress",'allocationId',r."allocationId",'attempt',(SELECT jsonb_build_object('id',x.id,'transactionHash',x."transactionHash",'handedOff',EXISTS(SELECT 1 FROM public."B25DispatchHandoff" h WHERE h."attemptId"=x.id)) FROM public."B25LocalAttempt" x WHERE x."intentId"=iid));
END $$;
CREATE FUNCTION "b25_prepare_local_attempt"(iid TEXT,aid UUID,sid UUID,operator_address TEXT,operator_nonce BIGINT,tx_hash TEXT,calldata_hash TEXT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE b public."B25LocalIntentBinding"%ROWTYPE; r public."B24AuthorizationReservation"%ROWTYPE; p public."B24SpendingPolicy"%ROWTYPE; d public."B24Deployment"%ROWTYPE; existing public."B25LocalAttempt"%ROWTYPE;
BEGIN
 IF session_user<>'b25_executor' OR current_database()<>'b22_disposable_review' OR NOT EXISTS(SELECT 1 FROM b22_guard.marker WHERE value='b22-isolated-test-only') THEN RAISE EXCEPTION 'B25 executor not authorized' USING ERRCODE='42501'; END IF;
 SELECT * INTO b FROM public."B25LocalIntentBinding" WHERE "intentId"=iid FOR UPDATE;
 SELECT * INTO r FROM public."B24AuthorizationReservation" WHERE id=b."reservationId" FOR UPDATE;
 SELECT * INTO p FROM public."B24SpendingPolicy" WHERE id=r."policyId" FOR SHARE;
 SELECT * INTO d FROM public."B24Deployment" WHERE id=r."deploymentId" FOR SHARE;
 IF b."intentId" IS NULL OR b."sessionId"<>sid OR p.status<>'ACTIVE' OR d.status<>'TEST_FIXTURE' OR clock_timestamp()<p."effectiveAt" OR clock_timestamp()>=p."expiresAt" OR clock_timestamp()>=r.deadline OR NOT EXISTS(SELECT 1 FROM public."B24LocalChainSession" WHERE id=sid AND "reservationId"=r.id AND status='ACTIVE') THEN RAISE EXCEPTION 'B25 authorization expired or changed'; END IF;
 SELECT * INTO existing FROM public."B25LocalAttempt" WHERE "intentId"=iid;
 IF FOUND THEN RETURN jsonb_build_object('id',existing.id,'transactionHash',existing."transactionHash",'reused',true); END IF;
 INSERT INTO public."B25LocalAttempt"(id,"intentId","sessionId","operatorAddress","operatorNonce","transactionHash","calldataHash") VALUES(aid,iid,sid,operator_address,operator_nonce,tx_hash,calldata_hash);
 INSERT INTO public."V2SettlementAttempt"(id,"settlementId",sequence,status,"txHash","transactionIdentity",nonce,"updatedAt") VALUES(aid,iid,1,'SIGNED',tx_hash,calldata_hash,operator_nonce,clock_timestamp());
 RETURN jsonb_build_object('id',aid,'transactionHash',tx_hash,'reused',false);
END $$;
REVOKE ALL ON FUNCTION "b25_local_context"(TEXT), "b25_prepare_local_attempt"(TEXT,UUID,UUID,TEXT,BIGINT,TEXT,TEXT) FROM PUBLIC;
CREATE TABLE "B25LocalEvidence" (
 "evidenceId" UUID PRIMARY KEY REFERENCES "V2SettlementEvidence"(id) ON DELETE RESTRICT,
 "attemptId" UUID NOT NULL UNIQUE REFERENCES "B25LocalAttempt"(id) ON DELETE RESTRICT,
 "sessionId" UUID NOT NULL REFERENCES "B24LocalChainSession"(id) ON DELETE RESTRICT,
 "settlementDigest" VARCHAR(66) NOT NULL,
 "blockHash" VARCHAR(66) NOT NULL,
 "blockNumber" BIGINT NOT NULL CHECK ("blockNumber">=0),
 "transferLogIndex" INT NOT NULL CHECK ("transferLogIndex">=0),
 "verifiedBy" TEXT NOT NULL,
 "verifiedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER "B25Evidence_immutable" BEFORE UPDATE OR DELETE ON "B25LocalEvidence" FOR EACH ROW EXECUTE FUNCTION "b25_immutable_binding"();
CREATE FUNCTION "b25_receipt_context"(aid UUID) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public."B25LocalAttempt"%ROWTYPE; b public."B25LocalIntentBinding"%ROWTYPE; r public."B24AuthorizationReservation"%ROWTYPE; d public."B24Deployment"%ROWTYPE; s TEXT;
BEGIN
 IF session_user<>'b25_verifier' OR current_database()<>'b22_disposable_review' OR NOT EXISTS(SELECT 1 FROM b22_guard.marker WHERE value='b22-isolated-test-only') THEN RAISE EXCEPTION 'B25 verifier not authorized' USING ERRCODE='42501'; END IF;
 SELECT * INTO a FROM public."B25LocalAttempt" WHERE id=aid;
 SELECT * INTO b FROM public."B25LocalIntentBinding" WHERE "intentId"=a."intentId";
 SELECT * INTO r FROM public."B24AuthorizationReservation" WHERE id=b."reservationId";
 SELECT * INTO d FROM public."B24Deployment" WHERE id=r."deploymentId";
 SELECT signature INTO s FROM public."B24SignedAuthorization" WHERE "reservationId"=r.id AND "settlementId"=r."settlementId";
 IF a.id IS NULL OR s IS NULL THEN RAISE EXCEPTION 'B25 attempt missing'; END IF;
 RETURN jsonb_build_object('intentId',a."intentId",'reservationId',r.id,'sessionId',b."sessionId",'buyerAddress',r."buyerAddress",'settlementId',r."settlementId",'terms',r.terms,'signature',s,'contractAddress',d."contractAddress",'tokenAddress',d."tokenAddress",'allocationId',r."allocationId",'transactionHash',a."transactionHash",'operatorAddress',a."operatorAddress",'operatorNonce',a."operatorNonce"::text,'calldataHash',a."calldataHash",'recordedEvidence',(SELECT jsonb_build_object('blockHash',e."blockHash",'blockNumber',e."blockNumber"::text) FROM public."B25LocalEvidence" e WHERE e."attemptId"=aid),'recordedRevert',(SELECT jsonb_build_object('blockHash',e."blockHash",'blockNumber',e."blockNumber"::text) FROM public."B25RevertEvidence" e WHERE e."attemptId"=aid));
END $$;
CREATE FUNCTION "b25_record_local_evidence"(aid UUID,eid UUID,block_hash TEXT,block_number BIGINT,settlement_index INT,transfer_index INT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public."B25LocalAttempt"%ROWTYPE; b public."B25LocalIntentBinding"%ROWTYPE; r public."B24AuthorizationReservation"%ROWTYPE; i public."V2SettlementIntent"%ROWTYPE; alloc public."V2Allocation"%ROWTYPE; prior public."B25LocalEvidence"%ROWTYPE;
BEGIN
 IF session_user<>'b25_verifier' OR current_database()<>'b22_disposable_review' OR NOT EXISTS(SELECT 1 FROM b22_guard.marker WHERE value='b22-isolated-test-only') THEN RAISE EXCEPTION 'B25 verifier not authorized' USING ERRCODE='42501'; END IF;
 IF block_hash !~ '^0x[0-9a-f]{64}$' OR block_number<0 OR settlement_index<0 OR transfer_index<0 THEN RAISE EXCEPTION 'Invalid B25 receipt identity'; END IF;
 SELECT * INTO a FROM public."B25LocalAttempt" WHERE id=aid FOR UPDATE;
 SELECT * INTO b FROM public."B25LocalIntentBinding" WHERE "intentId"=a."intentId";
 SELECT * INTO r FROM public."B24AuthorizationReservation" WHERE id=b."reservationId";
 SELECT * INTO i FROM public."V2SettlementIntent" WHERE id=b."intentId" FOR UPDATE;
 SELECT * INTO alloc FROM public."V2Allocation" WHERE id=i."allocationId";
 IF a.id IS NULL OR i.id IS NULL THEN RAISE EXCEPTION 'B25 attempt missing'; END IF;
 IF EXISTS(SELECT 1 FROM public."B25RevertEvidence" WHERE "attemptId"=aid) THEN RAISE EXCEPTION 'B25 attempt has historical revert evidence'; END IF;
 SELECT * INTO prior FROM public."B25LocalEvidence" WHERE "attemptId"=aid;
 IF FOUND THEN
  IF i.status<>'CONFIRMED' THEN RAISE EXCEPTION 'B25 evidence requires manual reconciliation'; END IF;
  IF prior."blockHash"<>block_hash OR prior."blockNumber"<>block_number OR prior."transferLogIndex"<>transfer_index OR NOT EXISTS(SELECT 1 FROM public."V2SettlementEvidence" WHERE id=prior."evidenceId" AND "logIndex"=settlement_index) THEN RAISE EXCEPTION 'Conflicting B25 evidence'; END IF;
  RETURN jsonb_build_object('evidenceId',prior."evidenceId",'reused',true);
 END IF;
 INSERT INTO public."V2SettlementEvidence"(id,"settlementId","chainId","contractAddress","tokenAddress","txHash","blockReference","receiptStatus","logIndex","buyerAddress","sellerAddress","amountBaseUnits","confirmedAt","verificationStatus") VALUES(eid,i.id,31337,i."contractAddress",i."tokenAddress",a."transactionHash",block_hash,'SUCCESS',settlement_index,alloc."buyerAddress",alloc."sellerAddress",i."amountBaseUnits",clock_timestamp(),'VERIFIED');
 INSERT INTO public."B25LocalEvidence"("evidenceId","attemptId","sessionId","settlementDigest","blockHash","blockNumber","transferLogIndex","verifiedBy") VALUES(eid,aid,a."sessionId",r."settlementId",block_hash,block_number,transfer_index,session_user);
 UPDATE public."V2SettlementIntent" SET status='CONFIRMED',"updatedAt"=clock_timestamp() WHERE id=i.id;
 UPDATE public."V2SettlementAttempt" SET status='CONFIRMED',"updatedAt"=clock_timestamp() WHERE id=aid;
 RETURN jsonb_build_object('evidenceId',eid,'reused',false);
END $$;
REVOKE ALL ON FUNCTION "b25_receipt_context"(UUID), "b25_record_local_evidence"(UUID,UUID,TEXT,BIGINT,INT,INT) FROM PUBLIC;
CREATE FUNCTION "b25_lock_local_submission"(aid UUID) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public."B25LocalAttempt"%ROWTYPE; b public."B25LocalIntentBinding"%ROWTYPE; r public."B24AuthorizationReservation"%ROWTYPE; p public."B24SpendingPolicy"%ROWTYPE; d public."B24Deployment"%ROWTYPE;
BEGIN
 IF session_user<>'b25_executor' OR current_database()<>'b22_disposable_review' OR NOT EXISTS(SELECT 1 FROM b22_guard.marker WHERE value='b22-isolated-test-only') THEN RAISE EXCEPTION 'B25 executor not authorized' USING ERRCODE='42501'; END IF;
 SELECT * INTO a FROM public."B25LocalAttempt" WHERE id=aid FOR UPDATE;
 SELECT * INTO b FROM public."B25LocalIntentBinding" WHERE "intentId"=a."intentId";
 SELECT * INTO r FROM public."B24AuthorizationReservation" WHERE id=b."reservationId" FOR UPDATE;
 SELECT * INTO p FROM public."B24SpendingPolicy" WHERE id=r."policyId" FOR SHARE;
 SELECT * INTO d FROM public."B24Deployment" WHERE id=r."deploymentId" FOR SHARE;
 IF a.id IS NULL OR r.status<>'RESERVED' OR p.status<>'ACTIVE' OR d.status<>'TEST_FIXTURE' OR clock_timestamp()<p."effectiveAt" OR clock_timestamp()>=p."expiresAt" OR clock_timestamp()>=r.deadline OR NOT EXISTS(SELECT 1 FROM public."B24LocalChainSession" WHERE id=a."sessionId" AND status='ACTIVE') THEN RAISE EXCEPTION 'B25 authorization expired or changed'; END IF;
END $$;
REVOKE ALL ON FUNCTION "b25_lock_local_submission"(UUID) FROM PUBLIC;
CREATE TABLE "B25EvidenceObservation" (
 id UUID PRIMARY KEY,
 "attemptId" UUID NOT NULL REFERENCES "B25LocalAttempt"(id) ON DELETE RESTRICT,
 state TEXT NOT NULL CHECK(state='NONCANONICAL'),
 "observedBy" TEXT NOT NULL,
 "observedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER "B25Observation_immutable" BEFORE UPDATE OR DELETE ON "B25EvidenceObservation" FOR EACH ROW EXECUTE FUNCTION "b25_immutable_binding"();
CREATE FUNCTION "b25_mark_noncanonical"(aid UUID,oid UUID) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public."B25LocalAttempt"%ROWTYPE;
BEGIN
 IF session_user<>'b25_verifier' OR current_database()<>'b22_disposable_review' OR NOT EXISTS(SELECT 1 FROM b22_guard.marker WHERE value='b22-isolated-test-only') THEN RAISE EXCEPTION 'B25 verifier not authorized' USING ERRCODE='42501'; END IF;
 SELECT * INTO a FROM public."B25LocalAttempt" WHERE id=aid FOR UPDATE;
 IF a.id IS NULL OR (NOT EXISTS(SELECT 1 FROM public."B25LocalEvidence" WHERE "attemptId"=aid) AND NOT EXISTS(SELECT 1 FROM public."B25RevertEvidence" WHERE "attemptId"=aid)) THEN RAISE EXCEPTION 'B25 verified evidence missing'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public."B25EvidenceObservation" WHERE "attemptId"=aid AND state='NONCANONICAL') THEN
  INSERT INTO public."B25EvidenceObservation"(id,"attemptId",state,"observedBy") VALUES(oid,aid,'NONCANONICAL',session_user);
 END IF;
 UPDATE public."V2SettlementIntent" SET status='UNKNOWN',"updatedAt"=clock_timestamp() WHERE id=a."intentId";
 UPDATE public."V2SettlementAttempt" SET status='NEEDS_RECONCILIATION',"updatedAt"=clock_timestamp() WHERE id=aid;
END $$;
REVOKE ALL ON FUNCTION "b25_mark_noncanonical"(UUID,UUID) FROM PUBLIC;

-- Committing this immutable row is the authorization and irreversible-handoff
-- boundary. After commit a delayed broadcaster may still send despite revocation.
CREATE TABLE "B25DispatchHandoff" (
 "attemptId" UUID PRIMARY KEY REFERENCES "B25LocalAttempt"(id) ON DELETE RESTRICT,
 "authorizedBy" TEXT NOT NULL,
 "authorizedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER "B25Handoff_immutable" BEFORE UPDATE OR DELETE ON "B25DispatchHandoff" FOR EACH ROW EXECUTE FUNCTION "b25_immutable_binding"();
CREATE FUNCTION "b25_authorize_handoff"(aid UUID) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public."B25LocalAttempt"%ROWTYPE;
BEGIN
 PERFORM public."b25_lock_local_submission"(aid);
 SELECT * INTO a FROM public."B25LocalAttempt" WHERE id=aid;
 IF EXISTS (SELECT 1 FROM public."B25DispatchHandoff" WHERE "attemptId"=aid) THEN RAISE EXCEPTION 'B25 dispatch already handed off'; END IF;
 INSERT INTO public."B25DispatchHandoff"("attemptId","authorizedBy") VALUES(aid,session_user);
 UPDATE public."V2SettlementAttempt" SET status='NEEDS_RECONCILIATION',"updatedAt"=clock_timestamp() WHERE id=aid;
 UPDATE public."V2SettlementIntent" SET status='UNKNOWN',"updatedAt"=clock_timestamp() WHERE id=a."intentId";
END $$;
REVOKE ALL ON FUNCTION "b25_authorize_handoff"(UUID) FROM PUBLIC;
CREATE TABLE "B25RecoveryObservation" (
 id UUID PRIMARY KEY,
 "attemptId" UUID NOT NULL REFERENCES "B25LocalAttempt"(id) ON DELETE RESTRICT,
 state TEXT NOT NULL CHECK(state='NONCE_CONFLICT'),
 "conflictingTransactionHash" VARCHAR(66) NOT NULL CHECK ("conflictingTransactionHash" ~ '^0x[0-9a-f]{64}$'),
 "observedBy" TEXT NOT NULL,
 "observedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
 UNIQUE ("attemptId",state,"conflictingTransactionHash")
);
CREATE TRIGGER "B25RecoveryObservation_immutable" BEFORE UPDATE OR DELETE ON "B25RecoveryObservation" FOR EACH ROW EXECUTE FUNCTION "b25_immutable_binding"();
CREATE FUNCTION "b25_record_nonce_conflict"(aid UUID,oid UUID,conflicting_hash TEXT) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public."B25LocalAttempt"%ROWTYPE;
BEGIN
 IF session_user<>'b25_verifier' OR current_database()<>'b22_disposable_review' OR NOT EXISTS(SELECT 1 FROM b22_guard.marker WHERE value='b22-isolated-test-only') THEN RAISE EXCEPTION 'B25 verifier not authorized' USING ERRCODE='42501'; END IF;
 SELECT * INTO a FROM public."B25LocalAttempt" WHERE id=aid FOR UPDATE;
 IF a.id IS NULL OR conflicting_hash !~ '^0x[0-9a-f]{64}$' OR conflicting_hash=a."transactionHash" OR EXISTS(SELECT 1 FROM public."B25LocalEvidence" WHERE "attemptId"=aid) THEN RAISE EXCEPTION 'Invalid B25 nonce conflict'; END IF;
 INSERT INTO public."B25RecoveryObservation"(id,"attemptId",state,"conflictingTransactionHash","observedBy") VALUES(oid,aid,'NONCE_CONFLICT',conflicting_hash,session_user) ON CONFLICT ("attemptId",state,"conflictingTransactionHash") DO NOTHING;
 UPDATE public."V2SettlementIntent" SET status='UNKNOWN',"updatedAt"=clock_timestamp() WHERE id=a."intentId";
 UPDATE public."V2SettlementAttempt" SET status='NEEDS_RECONCILIATION',"updatedAt"=clock_timestamp() WHERE id=aid;
END $$;
REVOKE ALL ON FUNCTION "b25_record_nonce_conflict"(UUID,UUID,TEXT) FROM PUBLIC;

-- The verifier/RPC remains trusted. Negative evidence is immutable and is
-- never inserted into the verified-success evidence table.
CREATE TABLE "B25RevertEvidence" (
 id UUID PRIMARY KEY,
 "attemptId" UUID NOT NULL UNIQUE REFERENCES "B25LocalAttempt"(id) ON DELETE RESTRICT,
 "blockHash" VARCHAR(66) NOT NULL CHECK ("blockHash" ~ '^0x[0-9a-f]{64}$'),
 "blockNumber" BIGINT NOT NULL CHECK ("blockNumber">=0),
 "verifiedBy" TEXT NOT NULL,
 "verifiedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER "B25Revert_immutable" BEFORE UPDATE OR DELETE ON "B25RevertEvidence" FOR EACH ROW EXECUTE FUNCTION "b25_immutable_binding"();
CREATE FUNCTION "b25_record_revert"(aid UUID,eid UUID,bhash TEXT,bnumber BIGINT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public."B25LocalAttempt"%ROWTYPE; old public."B25RevertEvidence"%ROWTYPE;
BEGIN
 IF session_user<>'b25_verifier' OR current_database()<>'b22_disposable_review' OR NOT EXISTS(SELECT 1 FROM b22_guard.marker WHERE value='b22-isolated-test-only') THEN RAISE EXCEPTION 'B25 verifier not authorized' USING ERRCODE='42501'; END IF;
 SELECT * INTO a FROM public."B25LocalAttempt" WHERE id=aid FOR UPDATE;
 IF a.id IS NULL OR bhash !~ '^0x[0-9a-f]{64}$' OR bnumber<0 OR EXISTS(SELECT 1 FROM public."B25LocalEvidence" WHERE "attemptId"=aid) OR EXISTS(SELECT 1 FROM public."V2SettlementEvidence" WHERE "settlementId"=a."intentId" AND "verificationStatus"='VERIFIED' AND "receiptStatus"='SUCCESS') THEN RAISE EXCEPTION 'Invalid B25 revert evidence'; END IF;
 SELECT * INTO old FROM public."B25RevertEvidence" WHERE "attemptId"=aid;
 IF FOUND THEN
  IF old."blockHash"<>bhash OR old."blockNumber"<>bnumber OR EXISTS(SELECT 1 FROM public."B25EvidenceObservation" WHERE "attemptId"=aid AND state='NONCANONICAL') THEN RAISE EXCEPTION 'B25 revert evidence requires reconciliation'; END IF;
  RETURN jsonb_build_object('evidenceId',old.id,'reused',true);
 END IF;
 INSERT INTO public."B25RevertEvidence"(id,"attemptId","blockHash","blockNumber","verifiedBy") VALUES(eid,aid,bhash,bnumber,session_user);
 UPDATE public."V2SettlementIntent" SET status='REVERTED',"updatedAt"=clock_timestamp() WHERE id=a."intentId";
 UPDATE public."V2SettlementAttempt" SET status='REVERTED',"updatedAt"=clock_timestamp() WHERE id=aid;
 RETURN jsonb_build_object('evidenceId',eid,'reused',false);
END $$;
REVOKE ALL ON FUNCTION "b25_record_revert"(UUID,UUID,TEXT,BIGINT) FROM PUBLIC;
