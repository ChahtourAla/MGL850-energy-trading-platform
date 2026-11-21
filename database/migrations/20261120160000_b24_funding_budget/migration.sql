-- A budget is shared across grants and sessions for one local buyer/token/minter.
CREATE TABLE "B24LocalFundingBudget" (
 id UUID PRIMARY KEY,
 "buyerAddress" VARCHAR(42) NOT NULL CHECK ("buyerAddress" ~ '^0x[0-9a-f]{40}$'),
 "tokenAddress" VARCHAR(42) NOT NULL CHECK ("tokenAddress" ~ '^0x[0-9a-f]{40}$'),
 "minterAddress" VARCHAR(42) NOT NULL CHECK ("minterAddress" ~ '^0x[0-9a-f]{40}$'),
 "cumulativeLimit" BIGINT NOT NULL CHECK ("cumulativeLimit">=0),
 status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
 "approvedBy" VARCHAR(128) NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE ("buyerAddress","tokenAddress","minterAddress")
);
CREATE TABLE "B24LocalFundingBudgetGrant" (
 "grantId" UUID PRIMARY KEY REFERENCES "B24LocalFundingGrant"(id) ON DELETE RESTRICT,
 "budgetId" UUID NOT NULL REFERENCES "B24LocalFundingBudget"(id) ON DELETE RESTRICT
);
CREATE FUNCTION "b24_local_funding_budget_guard"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF session_user<>'b24_approver' OR current_database()<>'b22_disposable_review' OR NOT EXISTS(SELECT 1 FROM b22_guard.marker WHERE value='b22-isolated-test-only') THEN RAISE EXCEPTION 'funding budget approver not authorized' USING ERRCODE='42501'; END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'funding budget facts immutable'; END IF;
 IF TG_TABLE_NAME='B24LocalFundingBudget' THEN
  IF TG_OP='INSERT' THEN NEW."approvedBy":=session_user;
  ELSIF (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') OR OLD.status<>'ACTIVE' OR NEW.status<>'REVOKED' THEN RAISE EXCEPTION 'funding budget facts immutable'; END IF;
 ELSE
  IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM public."B24LocalFundingGrant" g JOIN public."B24LocalChainSession" s ON s.id=g."sessionId" JOIN public."B24LocalFundingBudget" b ON b.id=NEW."budgetId" WHERE g.id=NEW."grantId" AND b.status='ACTIVE' AND s.status='ACTIVE' AND b."buyerAddress"=s."buyerAddress" AND b."tokenAddress"=s."tokenAddress" AND b."minterAddress"=g."minterAddress") THEN RAISE EXCEPTION 'funding budget binding invalid'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "B24LocalFundingBudget_guard" BEFORE INSERT OR UPDATE OR DELETE ON "B24LocalFundingBudget" FOR EACH ROW EXECUTE FUNCTION "b24_local_funding_budget_guard"();
CREATE TRIGGER "B24LocalFundingBudgetGrant_guard" BEFORE INSERT OR UPDATE OR DELETE ON "B24LocalFundingBudgetGrant" FOR EACH ROW EXECUTE FUNCTION "b24_local_funding_budget_guard"();
REVOKE ALL ON "B24LocalFundingBudget","B24LocalFundingBudgetGrant" FROM PUBLIC;
