-- Append-only canonicality decisions. The authenticated verifier and its RPC
-- remain trusted; PostgreSQL cannot independently establish chain canonicality.
CREATE TABLE "B25CanonicalOutcomeEvent" (
 id UUID PRIMARY KEY,
 "attemptId" UUID NOT NULL REFERENCES "B25LocalAttempt"(id) ON DELETE RESTRICT,
 "intentId" VARCHAR(66) NOT NULL REFERENCES "B25LocalIntentBinding"("intentId") ON DELETE RESTRICT,
 "sessionId" UUID NOT NULL REFERENCES "B24LocalChainSession"(id) ON DELETE RESTRICT,
 "transactionHash" VARCHAR(66) NOT NULL,
 "operatorNonce" BIGINT NOT NULL,
 "calldataHash" VARCHAR(66) NOT NULL,
 "settlementDigest" VARCHAR(66) NOT NULL,
 sequence INTEGER NOT NULL CHECK (sequence > 0),
 outcome TEXT NOT NULL CHECK (outcome IN ('SUCCESS','REVERTED','NONCANONICAL')),
 "blockHash" VARCHAR(66) NOT NULL CHECK ("blockHash" ~ '^0x[0-9a-f]{64}$'),
 "blockNumber" BIGINT NOT NULL CHECK ("blockNumber" >= 0),
 "settlementLogIndex" INTEGER,
 "transferLogIndex" INTEGER,
 "supersedesId" UUID REFERENCES "B25CanonicalOutcomeEvent"(id) ON DELETE RESTRICT,
 "verifiedBy" TEXT NOT NULL,
 "verifiedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
 UNIQUE ("attemptId", sequence),
 CHECK ((outcome = 'SUCCESS' AND "settlementLogIndex" >= 0 AND "transferLogIndex" >= 0) OR (outcome <> 'SUCCESS' AND "settlementLogIndex" IS NULL AND "transferLogIndex" IS NULL))
);
CREATE TRIGGER "B25CanonicalOutcome_immutable" BEFORE UPDATE OR DELETE ON "B25CanonicalOutcomeEvent" FOR EACH ROW EXECUTE FUNCTION "b25_immutable_binding"();

CREATE FUNCTION "b25_record_outcome"(aid UUID, eid UUID, kind TEXT, bhash TEXT, bnumber BIGINT, settlement_index INTEGER, transfer_index INTEGER, expected UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public."B25LocalAttempt"%ROWTYPE; b public."B25LocalIntentBinding"%ROWTYPE; old public."B25CanonicalOutcomeEvent"%ROWTYPE; i public."V2SettlementIntent"%ROWTYPE; alloc public."V2Allocation"%ROWTYPE; seq INTEGER;
BEGIN
 IF session_user<>'b25_verifier' OR current_database()<>'b22_disposable_review' OR NOT EXISTS(SELECT 1 FROM b22_guard.marker WHERE value='b22-isolated-test-only') THEN RAISE EXCEPTION 'B25 verifier not authorized' USING ERRCODE='42501'; END IF;
 SELECT * INTO a FROM public."B25LocalAttempt" WHERE id=aid FOR UPDATE;
 SELECT * INTO b FROM public."B25LocalIntentBinding" WHERE "intentId"=a."intentId";
 IF a.id IS NULL OR NOT EXISTS(SELECT 1 FROM public."B25DispatchHandoff" WHERE "attemptId"=aid) OR kind NOT IN ('SUCCESS','REVERTED','NONCANONICAL') OR bhash !~ '^0x[0-9a-f]{64}$' OR bnumber<0 THEN RAISE EXCEPTION 'Invalid B25 outcome identity'; END IF;
 IF (kind='SUCCESS' AND (settlement_index IS NULL OR settlement_index<0 OR transfer_index IS NULL OR transfer_index<0)) OR (kind<>'SUCCESS' AND (settlement_index IS NOT NULL OR transfer_index IS NOT NULL)) THEN RAISE EXCEPTION 'Invalid B25 outcome logs'; END IF;
 SELECT * INTO old FROM public."B25CanonicalOutcomeEvent" WHERE "attemptId"=aid ORDER BY sequence DESC LIMIT 1;
 IF old.outcome=kind AND old."blockHash"=bhash AND old."blockNumber"=bnumber AND old."settlementLogIndex" IS NOT DISTINCT FROM settlement_index AND old."transferLogIndex" IS NOT DISTINCT FROM transfer_index THEN RETURN jsonb_build_object('eventId',old.id,'reused',true); END IF;
 IF old.id IS DISTINCT FROM expected THEN RAISE EXCEPTION 'B25 outcome changed concurrently'; END IF;
 IF old.id IS NULL AND kind='NONCANONICAL' THEN RAISE EXCEPTION 'B25 outcome missing'; END IF;
 IF old.id IS NOT NULL AND ((kind='NONCANONICAL' AND (old.outcome NOT IN ('SUCCESS','REVERTED') OR old."blockHash"<>bhash OR old."blockNumber"<>bnumber)) OR (kind<>'NONCANONICAL' AND old.outcome<>'NONCANONICAL')) THEN RAISE EXCEPTION 'B25 prior outcome must be noncanonical'; END IF;
 -- Preserve the original B21/B25 evidence row exactly once. Later canonical
 -- observations deliberately do not insert another B21 tx/log identity.
 IF old.id IS NULL THEN
  IF kind='SUCCESS' THEN PERFORM public."b25_record_local_evidence"(aid,eid,bhash,bnumber,settlement_index,transfer_index);
  ELSE PERFORM public."b25_record_revert"(aid,eid,bhash,bnumber); END IF;
 END IF;
 IF kind='SUCCESS' AND NOT EXISTS(SELECT 1 FROM public."V2SettlementEvidence" WHERE "settlementId"=a."intentId" AND "verificationStatus"='VERIFIED' AND "receiptStatus"='SUCCESS') THEN
  SELECT * INTO i FROM public."V2SettlementIntent" WHERE id=a."intentId";
  SELECT * INTO alloc FROM public."V2Allocation" WHERE id=i."allocationId";
  INSERT INTO public."V2SettlementEvidence"(id,"settlementId","chainId","contractAddress","tokenAddress","txHash","blockReference","receiptStatus","logIndex","buyerAddress","sellerAddress","amountBaseUnits","confirmedAt","verificationStatus") VALUES(eid,i.id,31337,i."contractAddress",i."tokenAddress",a."transactionHash",bhash,'SUCCESS',settlement_index,alloc."buyerAddress",alloc."sellerAddress",i."amountBaseUnits",clock_timestamp(),'VERIFIED');
 END IF;
 seq=COALESCE(old.sequence,0)+1;
 INSERT INTO public."B25CanonicalOutcomeEvent"(id,"attemptId","intentId","sessionId","transactionHash","operatorNonce","calldataHash","settlementDigest",sequence,outcome,"blockHash","blockNumber","settlementLogIndex","transferLogIndex","supersedesId","verifiedBy") VALUES(eid,aid,a."intentId",a."sessionId",a."transactionHash",a."operatorNonce",a."calldataHash",b."settlementDigest",seq,kind,bhash,bnumber,settlement_index,transfer_index,old.id,session_user);
 UPDATE public."V2SettlementIntent" SET status=CASE kind WHEN 'SUCCESS' THEN 'CONFIRMED' WHEN 'REVERTED' THEN 'REVERTED' ELSE 'UNKNOWN' END,"updatedAt"=clock_timestamp() WHERE id=a."intentId";
 UPDATE public."V2SettlementAttempt" SET status=CASE kind WHEN 'SUCCESS' THEN 'CONFIRMED' WHEN 'REVERTED' THEN 'REVERTED' ELSE 'NEEDS_RECONCILIATION' END,"updatedAt"=clock_timestamp() WHERE id=aid;
 RETURN jsonb_build_object('eventId',eid,'reused',false);
END $$;
REVOKE ALL ON FUNCTION "b25_record_outcome"(UUID,UUID,TEXT,TEXT,BIGINT,INTEGER,INTEGER,UUID) FROM PUBLIC;
