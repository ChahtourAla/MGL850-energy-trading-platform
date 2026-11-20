-- Preserve previously applied drafts and fail closed on populated V2 plans.
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM "V2Allocation") OR EXISTS (SELECT 1 FROM "V2AllocationPlan" WHERE status='AUTHORITATIVE') THEN
  RAISE EXCEPTION 'Existing V2 allocations or authoritative plans require payment-readiness migration review';
 END IF;
END $$;

CREATE FUNCTION "v2_payment_allocation_gate"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE plan "V2AllocationPlan"%ROWTYPE; buyer JSONB; seller JSONB;
BEGIN
 PERFORM 1 FROM "V2Market" WHERE id=NEW."marketId" FOR UPDATE;
 SELECT * INTO plan FROM "V2AllocationPlan" WHERE id=NEW."planId" FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'allocation plan mismatch'; END IF;
 IF TG_OP='INSERT' AND NEW.status<>'PLANNED' THEN RAISE EXCEPTION 'allocation must begin planned'; END IF;
 IF TG_OP='UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
  IF NOT ((OLD.status='PLANNED' AND NEW.status IN ('VALIDATED','CANCELLED')) OR (OLD.status='VALIDATED' AND NEW.status='CANCELLED' AND plan.status='DRAFT')) THEN
   RAISE EXCEPTION 'invalid allocation status transition';
  END IF;
 END IF;
 SELECT x INTO buyer FROM jsonb_array_elements(plan.manifest->'participants') x WHERE x->>'userId'=NEW."buyerId"::text AND x->>'marketRole'='BUYER' AND x->>'evmAddress'=NEW."buyerAddress";
 SELECT x INTO seller FROM jsonb_array_elements(plan.manifest->'participants') x WHERE x->>'userId'=NEW."sellerId"::text AND x->>'marketRole'='SELLER' AND x->>'evmAddress'=NEW."sellerAddress";
 IF buyer IS NULL OR seller IS NULL THEN RAISE EXCEPTION 'allocation parties absent from manifest'; END IF;
 IF NEW."algorithmVersion" IS DISTINCT FROM plan.manifest->>'algorithmVersion' THEN RAISE EXCEPTION 'allocation algorithm version mismatch'; END IF;
 IF NEW."pricingVersion" IS DISTINCT FROM plan.manifest->>'pricingPolicyVersion' THEN RAISE EXCEPTION 'allocation pricing version mismatch'; END IF;
 IF NEW."quantityWh" > (buyer->>'requiredWh')::bigint THEN RAISE EXCEPTION 'allocation exceeds buyer demand'; END IF;
 IF NEW."quantityWh" > (seller->>'availableWh')::bigint THEN RAISE EXCEPTION 'allocation exceeds seller supply'; END IF;
 IF NEW."unitPriceMicrousdPerKwh" < (seller->>'askPriceMicrousdPerKwh')::bigint THEN RAISE EXCEPTION 'allocation price below seller ask'; END IF;
 IF NEW."unitPriceMicrousdPerKwh" > (buyer->>'maxPriceMicrousdPerKwh')::bigint THEN RAISE EXCEPTION 'allocation price above buyer maximum'; END IF;
 IF buyer->>'preferredEnergyType'<>'ANY' AND buyer->>'preferredEnergyType'<>seller->>'energyType' THEN RAISE EXCEPTION 'allocation incompatible energy type'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "B21Payment_allocation_gate" BEFORE INSERT OR UPDATE ON "V2Allocation" FOR EACH ROW EXECUTE FUNCTION "v2_payment_allocation_gate"();

CREATE FUNCTION "v2_payment_plan_gate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM "V2Market" WHERE id=NEW."marketId" FOR UPDATE;
 IF NEW.status='AUTHORITATIVE' AND EXISTS (SELECT 1 FROM "V2Allocation" WHERE "planId"=NEW.id AND status='PLANNED') THEN
  RAISE EXCEPTION 'authoritative plan contains unvalidated allocation';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "B21Payment_plan_gate" BEFORE INSERT OR UPDATE ON "V2AllocationPlan" FOR EACH ROW EXECUTE FUNCTION "v2_payment_plan_gate"();

CREATE FUNCTION "v2_payment_intent_gate"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a "V2Allocation"%ROWTYPE;
BEGIN
 PERFORM 1 FROM "V2Market" WHERE id=NEW."marketId" FOR UPDATE;
 SELECT * INTO a FROM "V2Allocation" WHERE id=NEW."allocationId" AND "marketId"=NEW."marketId" FOR UPDATE;
 IF NOT FOUND OR a.status<>'VALIDATED' THEN RAISE EXCEPTION 'payment requires validated allocation'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "B21Payment_intent_gate" BEFORE INSERT OR UPDATE ON "V2SettlementIntent" FOR EACH ROW EXECUTE FUNCTION "v2_payment_intent_gate"();
