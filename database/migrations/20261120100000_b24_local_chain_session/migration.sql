-- Offline fixture sessions. Database approval is separate from local RPC verification.
CREATE TABLE "B24LocalChainSession" (
 "id" UUID PRIMARY KEY,
 "reservationId" UUID NOT NULL REFERENCES "B24AuthorizationReservation"(id) ON DELETE RESTRICT,
 "deploymentId" UUID NOT NULL REFERENCES "B24Deployment"(id) ON DELETE RESTRICT,
 "buyerAddress" VARCHAR(42) NOT NULL,
 "tokenAddress" VARCHAR(42) NOT NULL,
 "contractAddress" VARCHAR(42) NOT NULL,
 "chainId" INTEGER NOT NULL CHECK ("chainId"=31337),
 "anchorTransactionHash" VARCHAR(66) NOT NULL,
 "anchorBlockHash" VARCHAR(66) NOT NULL,
 "anchorBlockNumber" BIGINT NOT NULL CHECK ("anchorBlockNumber">=0),
 "tokenRuntimeHash" VARCHAR(66) NOT NULL,
 "contractRuntimeHash" VARCHAR(66) NOT NULL,
 "status" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','RETIRED')),
 "approvedBy" VARCHAR(128) NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK ("buyerAddress" ~ '^0x[0-9a-f]{40}$' AND "tokenAddress" ~ '^0x[0-9a-f]{40}$' AND "contractAddress" ~ '^0x[0-9a-f]{40}$'),
 CHECK ("anchorTransactionHash" ~ '^0x[0-9a-f]{64}$' AND "anchorBlockHash" ~ '^0x[0-9a-f]{64}$' AND "tokenRuntimeHash" ~ '^0x[0-9a-f]{64}$' AND "contractRuntimeHash" ~ '^0x[0-9a-f]{64}$')
);
CREATE FUNCTION "b24_local_session_guard"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'local session facts are immutable'; END IF;
 IF session_user<>'b24_approver' OR current_database()<>'b22_disposable_review' OR NOT EXISTS(SELECT 1 FROM b22_guard.marker WHERE value='b22-isolated-test-only') THEN RAISE EXCEPTION 'local session approver not authorized' USING ERRCODE='42501'; END IF;
 IF TG_OP='INSERT' THEN
  NEW."approvedBy":=session_user;
  IF NOT EXISTS(SELECT 1 FROM "B24AuthorizationReservation" r JOIN "B24Deployment" d ON d.id=r."deploymentId" JOIN "B24SpendingPolicy" p ON p.id=r."policyId" WHERE r.id=NEW."reservationId" AND d.id=NEW."deploymentId" AND r."buyerAddress"=NEW."buyerAddress" AND d."tokenAddress"=NEW."tokenAddress" AND d."contractAddress"=NEW."contractAddress" AND d.status='TEST_FIXTURE' AND d."chainId"=31337 AND p.status='ACTIVE' AND clock_timestamp()<p."expiresAt" AND clock_timestamp()<r.deadline) THEN RAISE EXCEPTION 'local session context invalid'; END IF;
 ELSIF (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') OR OLD.status<>'ACTIVE' OR NEW.status<>'RETIRED' THEN RAISE EXCEPTION 'local session facts are immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "B24LocalChainSession_guard" BEFORE INSERT OR UPDATE OR DELETE ON "B24LocalChainSession" FOR EACH ROW EXECUTE FUNCTION "b24_local_session_guard"();
REVOKE ALL ON "B24LocalChainSession" FROM PUBLIC;
