-- Additive, fail-closed correction: no prior authoritative V2 data is rewritten.
-- Existing V2 allocations or finalized snapshots require a separately reviewed migration.
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM "V2Allocation") OR EXISTS (SELECT 1 FROM "V2Snapshot" WHERE "status"='FINALIZED') THEN
   RAISE EXCEPTION 'Existing V2 financial or finalized snapshot data require manual migration review';
 END IF;
END $$;
-- AlterTable
ALTER TABLE "V2Allocation" ADD COLUMN     "planId" VARCHAR(66) NOT NULL;

-- CreateTable
CREATE TABLE "V2SnapshotMeasurement" (
    "snapshotId" UUID NOT NULL,
    "marketId" VARCHAR(66) NOT NULL,
    "userId" UUID NOT NULL,
    "productionWh" BIGINT NOT NULL,
    "consumptionWh" BIGINT NOT NULL,

    CONSTRAINT "V2SnapshotMeasurement_pkey" PRIMARY KEY ("snapshotId","userId")
);

-- CreateTable
CREATE TABLE "V2AllocationPlan" (
    "id" VARCHAR(66) NOT NULL,
    "marketId" VARCHAR(66) NOT NULL,
    "snapshotId" UUID NOT NULL,
    "planVersion" VARCHAR(128) NOT NULL,
    "manifestHash" VARCHAR(66) NOT NULL,
    "manifest" JSONB NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "V2AllocationPlan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "V2SnapshotMeasurement_marketId_userId_idx" ON "V2SnapshotMeasurement"("marketId", "userId");

-- CreateIndex
CREATE INDEX "V2AllocationPlan_marketId_status_idx" ON "V2AllocationPlan"("marketId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "V2AllocationPlan_id_marketId_snapshotId_key" ON "V2AllocationPlan"("id", "marketId", "snapshotId");

-- CreateIndex
CREATE UNIQUE INDEX "V2AllocationPlan_marketId_planVersion_key" ON "V2AllocationPlan"("marketId", "planVersion");

-- AddForeignKey
ALTER TABLE "V2Allocation" ADD CONSTRAINT "V2Allocation_planId_marketId_snapshotId_fkey" FOREIGN KEY ("planId", "marketId", "snapshotId") REFERENCES "V2AllocationPlan"("id", "marketId", "snapshotId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "V2SnapshotMeasurement" ADD CONSTRAINT "V2SnapshotMeasurement_snapshotId_marketId_fkey" FOREIGN KEY ("snapshotId", "marketId") REFERENCES "V2Snapshot"("id", "marketId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "V2SnapshotMeasurement" ADD CONSTRAINT "V2SnapshotMeasurement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "V2AllocationPlan" ADD CONSTRAINT "V2AllocationPlan_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "V2Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "V2AllocationPlan" ADD CONSTRAINT "V2AllocationPlan_snapshotId_marketId_fkey" FOREIGN KEY ("snapshotId", "marketId") REFERENCES "V2Snapshot"("id", "marketId") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "V2SnapshotMeasurement" ADD CONSTRAINT "V2Measurement_nonnegative" CHECK ("productionWh" >= 0 AND "consumptionWh" >= 0);
ALTER TABLE "V2AllocationPlan" ADD CONSTRAINT "V2Plan_status_format" CHECK ("status" IN ('DRAFT','SUPERSEDED','AUTHORITATIVE') AND "id" ~ '^0x[0-9a-f]{64}$' AND "manifestHash" ~ '^0x[0-9a-f]{64}$');
CREATE UNIQUE INDEX "V2Plan_one_authoritative_per_market" ON "V2AllocationPlan"("marketId") WHERE "status"='AUTHORITATIVE';

CREATE FUNCTION "v2_measurement_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE snap "V2Snapshot"%ROWTYPE; sid UUID;
BEGIN
 sid := CASE WHEN TG_OP='DELETE' THEN OLD."snapshotId" ELSE NEW."snapshotId" END;
 SELECT * INTO snap FROM "V2Snapshot" WHERE "id"=sid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'snapshot does not exist'; END IF;
 IF snap."status" <> 'PENDING' THEN RAISE EXCEPTION 'measurements require pending snapshot'; END IF;
 IF TG_OP='UPDATE' AND (NEW."snapshotId",NEW."marketId",NEW."userId") IS DISTINCT FROM (OLD."snapshotId",OLD."marketId",OLD."userId") THEN RAISE EXCEPTION 'measurement identity is immutable'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF NEW."marketId"<>snap."marketId" THEN RAISE EXCEPTION 'measurement market mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "V2Measurement_guard" BEFORE INSERT OR UPDATE OR DELETE ON "V2SnapshotMeasurement" FOR EACH ROW EXECUTE FUNCTION "v2_measurement_guard"();

CREATE FUNCTION "v2_snapshot_measurement_hash"(sid UUID) RETURNS TEXT LANGUAGE sql STABLE AS $$
 SELECT '0x'||encode(sha256(convert_to(replace(jsonb_build_array('mgl850:v2:snapshot:1',s."marketId",coalesce((SELECT jsonb_agg(jsonb_build_array(m."userId"::text,m."productionWh"::text,m."consumptionWh"::text) ORDER BY m."userId"::text COLLATE "C") FROM "V2SnapshotMeasurement" m WHERE m."snapshotId"=sid),'[]'::jsonb))::text,' ',''),'UTF8')),'hex') FROM "V2Snapshot" s WHERE s."id"=sid
$$;

CREATE FUNCTION "v2_snapshot_measurements_finalization"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n BIGINT;
BEGIN
 IF TG_OP='INSERT' AND NEW."status"='FINALIZED' THEN RAISE EXCEPTION 'snapshot must be created pending'; END IF;
 IF TG_OP='UPDATE' AND OLD."status"<>'FINALIZED' AND NEW."status"='FINALIZED' THEN
  SELECT count(*) INTO n FROM "V2SnapshotMeasurement" WHERE "snapshotId"=NEW."id";
  IF OLD."status"<>'PENDING' THEN RAISE EXCEPTION 'snapshot must be pending'; END IF;
  IF n<>NEW."expectedCount" OR n<>NEW."actualCount" THEN RAISE EXCEPTION 'snapshot measurements incomplete'; END IF;
  IF NEW."payloadHash" <> "v2_snapshot_measurement_hash"(NEW."id") THEN RAISE EXCEPTION 'snapshot measurement hash mismatch'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "V2Snapshot_measurements_finalization" BEFORE INSERT OR UPDATE ON "V2Snapshot" FOR EACH ROW EXECUTE FUNCTION "v2_snapshot_measurements_finalization"();


-- All manifest scalars are constrained to ASCII canonical forms before the
-- compact JSON array encoding is hashed; this matches the Python/Node format.
CREATE FUNCTION "v2_matching_manifest_hash"(m JSONB) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE item JSONB; w JSONB; rows JSONB; serialized TEXT; k TEXT; v TEXT; fields TEXT[] := ARRAY['userId','timeSlot','productionWh','consumptionWh','marketRole','availableWh','requiredWh','energyType','askPriceMicrousdPerKwh','maxPriceMicrousdPerKwh','xKm','yKm','reputation','preferredEnergyType','evmAddress'];
BEGIN
 IF position(chr(92) in m::text)>0 THEN RAISE EXCEPTION 'manifest contains noncanonical escapes'; END IF;
 IF jsonb_typeof(m)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(m))<>10 OR NOT (m ?& ARRAY['schemaVersion','marketId','snapshotHash','intervalStart','intervalEnd','algorithmVersion','pricingPolicyVersion','maximumDistanceKm','scoringWeights','participants']) THEN RAISE EXCEPTION 'invalid manifest structure'; END IF;
 FOR k IN SELECT unnest(ARRAY['schemaVersion','marketId','snapshotHash','intervalStart','intervalEnd','algorithmVersion','pricingPolicyVersion','maximumDistanceKm']) LOOP
  IF jsonb_typeof(m->k)<>'string' THEN RAISE EXCEPTION 'invalid manifest string'; END IF;
 END LOOP;
 IF m->>'schemaVersion'<>'1.0.0' OR m->>'marketId' !~ '^0x[0-9a-f]{64}$' OR m->>'snapshotHash' !~ '^0x[0-9a-f]{64}$' OR m->>'algorithmVersion' !~ '^[A-Za-z0-9._-]{1,128}$' OR m->>'pricingPolicyVersion' !~ '^[A-Za-z0-9._-]{1,128}$' THEN RAISE EXCEPTION 'invalid manifest identity'; END IF;
 IF m->>'intervalStart' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' OR m->>'intervalEnd' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' THEN RAISE EXCEPTION 'invalid manifest interval'; END IF;
 v:=m->>'maximumDistanceKm'; IF length(v)>40 OR v !~ '^(0|-?[1-9][0-9]*|-?(0|[1-9][0-9]*)\.[0-9]*[1-9])$' OR v::numeric<=0 THEN RAISE EXCEPTION 'invalid manifest distance'; END IF;
 w:=m->'scoringWeights'; IF jsonb_typeof(w)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(w))<>4 OR NOT (w ?& ARRAY['quantity','price','distance','reputation']) THEN RAISE EXCEPTION 'invalid manifest weights'; END IF;
 FOREACH k IN ARRAY ARRAY['quantity','price','distance','reputation'] LOOP
  v:=w->>k; IF jsonb_typeof(w->k)<>'string' OR length(v)>40 OR v !~ '^(0|-?[1-9][0-9]*|-?(0|[1-9][0-9]*)\.[0-9]*[1-9])$' OR v::numeric<0 OR v::numeric>1 THEN RAISE EXCEPTION 'invalid manifest weight'; END IF;
 END LOOP;
 IF abs((w->>'quantity')::numeric+(w->>'price')::numeric+(w->>'distance')::numeric+(w->>'reputation')::numeric-1)>0.000000001 THEN RAISE EXCEPTION 'invalid manifest weight total'; END IF;
 IF jsonb_typeof(m->'participants')<>'array' THEN RAISE EXCEPTION 'invalid manifest participants'; END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(m->'participants')) <> (SELECT count(DISTINCT x->>'userId') FROM jsonb_array_elements(m->'participants') x) THEN RAISE EXCEPTION 'duplicate manifest participant'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(m->'participants') LOOP
  IF jsonb_typeof(item)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(item))<>15 OR NOT (item ?& fields) THEN RAISE EXCEPTION 'invalid manifest participant'; END IF;
  FOREACH k IN ARRAY ARRAY['userId','timeSlot','productionWh','consumptionWh','marketRole','availableWh','requiredWh','xKm','yKm','reputation','preferredEnergyType','evmAddress'] LOOP
   IF jsonb_typeof(item->k)<>'string' THEN RAISE EXCEPTION 'invalid participant string'; END IF;
  END LOOP;
  IF item->>'userId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' OR item->>'evmAddress' !~ '^0x[0-9a-f]{40}$' OR item->>'timeSlot'<>m->>'intervalStart' THEN RAISE EXCEPTION 'invalid participant identity'; END IF;
  FOREACH k IN ARRAY ARRAY['productionWh','consumptionWh','availableWh','requiredWh','reputation'] LOOP
   v:=item->>k; IF length(v)>19 OR v !~ '^(0|[1-9][0-9]*)$' OR v::numeric>9223372036854775807 THEN RAISE EXCEPTION 'invalid participant integer'; END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['xKm','yKm'] LOOP
   v:=item->>k; IF length(v)>40 OR v !~ '^(0|-?[1-9][0-9]*|-?(0|[1-9][0-9]*)\.[0-9]*[1-9])$' THEN RAISE EXCEPTION 'invalid participant coordinate'; END IF;
  END LOOP;
  IF (item->>'reputation')::numeric > 100 THEN RAISE EXCEPTION 'invalid reputation'; END IF;
  IF item->>'preferredEnergyType' NOT IN ('ANY','SOLAR','WIND','HYDRO','GRID','MIXED') OR item->>'marketRole' NOT IN ('BUYER','SELLER','NEUTRAL') THEN RAISE EXCEPTION 'invalid participant role or preference'; END IF;
  IF jsonb_typeof(item->'energyType') NOT IN ('string','null') OR jsonb_typeof(item->'askPriceMicrousdPerKwh') NOT IN ('string','null') OR jsonb_typeof(item->'maxPriceMicrousdPerKwh') NOT IN ('string','null') THEN RAISE EXCEPTION 'invalid participant terms'; END IF;
  IF item->>'energyType' IS NOT NULL AND item->>'energyType' NOT IN ('SOLAR','WIND','HYDRO','GRID','MIXED') THEN RAISE EXCEPTION 'invalid energy type'; END IF;
  FOREACH k IN ARRAY ARRAY['askPriceMicrousdPerKwh','maxPriceMicrousdPerKwh'] LOOP
   v:=item->>k; IF v IS NOT NULL AND (length(v)>19 OR v !~ '^[1-9][0-9]*$' OR v::numeric>9223372036854775807) THEN RAISE EXCEPTION 'invalid participant price'; END IF;
  END LOOP;
  IF (item->>'availableWh')::numeric <> greatest((item->>'productionWh')::numeric-(item->>'consumptionWh')::numeric,0) OR (item->>'requiredWh')::numeric <> greatest((item->>'consumptionWh')::numeric-(item->>'productionWh')::numeric,0) THEN RAISE EXCEPTION 'invalid participant energy'; END IF;
  IF (item->>'marketRole'='SELLER' AND ((item->>'availableWh')::numeric=0 OR item->>'energyType' IS NULL OR item->>'askPriceMicrousdPerKwh' IS NULL OR item->>'maxPriceMicrousdPerKwh' IS NOT NULL)) OR (item->>'marketRole'='BUYER' AND ((item->>'requiredWh')::numeric=0 OR item->>'energyType' IS NOT NULL OR item->>'askPriceMicrousdPerKwh' IS NOT NULL OR item->>'maxPriceMicrousdPerKwh' IS NULL)) OR (item->>'marketRole'='NEUTRAL' AND ((item->>'availableWh')::numeric<>0 OR (item->>'requiredWh')::numeric<>0 OR item->>'energyType' IS NOT NULL OR item->>'askPriceMicrousdPerKwh' IS NOT NULL OR item->>'maxPriceMicrousdPerKwh' IS NOT NULL)) THEN RAISE EXCEPTION 'invalid participant role terms'; END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(jsonb_build_array(elem->'userId',elem->'timeSlot',elem->'productionWh',elem->'consumptionWh',elem->'marketRole',elem->'availableWh',elem->'requiredWh',elem->'energyType',elem->'askPriceMicrousdPerKwh',elem->'maxPriceMicrousdPerKwh',elem->'xKm',elem->'yKm',elem->'reputation',elem->'preferredEnergyType',elem->'evmAddress') ORDER BY (elem->>'userId') COLLATE "C"),'[]'::jsonb) INTO rows FROM jsonb_array_elements(m->'participants') elem;
 serialized:=replace(jsonb_build_array('mgl850:v2:matching-input:1',m->'marketId',m->'snapshotHash',m->'intervalStart',m->'intervalEnd',m->'algorithmVersion',m->'pricingPolicyVersion',m->'maximumDistanceKm',jsonb_build_array(w->'quantity',w->'price',w->'distance',w->'reputation'),rows)::text,' ','');
 RETURN '0x'||encode(sha256(convert_to(serialized,'UTF8')),'hex');
END $$;

CREATE FUNCTION "v2_plan_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE snap "V2Snapshot"%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'plan facts are immutable'; END IF;
 PERFORM 1 FROM "V2Market" WHERE "id"=NEW."marketId" FOR UPDATE;
 SELECT * INTO snap FROM "V2Snapshot" WHERE "id"=NEW."snapshotId" AND "marketId"=NEW."marketId" FOR UPDATE;
 IF NOT FOUND OR snap."status"<>'FINALIZED' THEN RAISE EXCEPTION 'plan requires finalized snapshot'; END IF;
 IF NEW."manifest"->>'schemaVersion' IS DISTINCT FROM '1.0.0' OR NEW."manifest"->>'marketId' IS DISTINCT FROM NEW."marketId" OR NEW."manifest"->>'snapshotHash' IS DISTINCT FROM snap."payloadHash" OR NEW."manifest"->>'intervalStart' IS DISTINCT FROM to_char(snap."intervalStart" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') OR NEW."manifest"->>'intervalEnd' IS DISTINCT FROM to_char(snap."intervalEnd" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') THEN RAISE EXCEPTION 'plan manifest source mismatch'; END IF;
 IF NEW."manifestHash" <> "v2_matching_manifest_hash"(NEW."manifest") THEN RAISE EXCEPTION 'plan manifest hash mismatch'; END IF;
 IF jsonb_array_length(NEW."manifest"->'participants') <> (SELECT count(*) FROM "V2SnapshotMeasurement" WHERE "snapshotId"=NEW."snapshotId") OR EXISTS (SELECT 1 FROM jsonb_array_elements(NEW."manifest"->'participants') x LEFT JOIN "V2SnapshotMeasurement" meas ON meas."snapshotId"=NEW."snapshotId" AND meas."userId"::text=x->>'userId' WHERE meas."userId" IS NULL OR meas."productionWh"::text<>x->>'productionWh' OR meas."consumptionWh"::text<>x->>'consumptionWh') THEN RAISE EXCEPTION 'plan measurements mismatch'; END IF;
 IF TG_OP='INSERT' AND NEW."status"<>'DRAFT' THEN RAISE EXCEPTION 'plan must begin draft'; END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') THEN RAISE EXCEPTION 'plan facts are immutable'; END IF;
  IF OLD."status"<>'DRAFT' AND NEW."status"<>OLD."status" THEN RAISE EXCEPTION 'activated or superseded plan is immutable'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "V2Plan_guard" BEFORE INSERT OR UPDATE OR DELETE ON "V2AllocationPlan" FOR EACH ROW EXECUTE FUNCTION "v2_plan_guard"();

CREATE OR REPLACE FUNCTION "v2_allocation_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE snap "V2Snapshot"%ROWTYPE; plan "V2AllocationPlan"%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'allocation facts are immutable'; END IF;
 IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') THEN RAISE EXCEPTION 'allocation facts are immutable'; END IF;
 PERFORM 1 FROM "V2Market" WHERE "id"=NEW."marketId" FOR UPDATE;
 SELECT * INTO snap FROM "V2Snapshot" WHERE "id"=NEW."snapshotId" AND "marketId"=NEW."marketId" FOR UPDATE;
 IF NOT FOUND OR snap."status"<>'FINALIZED' THEN RAISE EXCEPTION 'allocation requires finalized snapshot'; END IF;
 SELECT * INTO plan FROM "V2AllocationPlan" WHERE "id"=NEW."planId" AND "marketId"=NEW."marketId" AND "snapshotId"=NEW."snapshotId" FOR UPDATE;
 IF NOT FOUND OR plan."planVersion"<>NEW."planVersion" OR plan."status"='SUPERSEDED' THEN RAISE EXCEPTION 'allocation plan mismatch'; END IF;
 IF TG_OP='INSERT' AND plan."status"='AUTHORITATIVE' THEN RAISE EXCEPTION 'authoritative plan is sealed'; END IF;
 IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(plan."manifest"->'participants') x WHERE x->>'userId'=NEW."buyerId"::text AND x->>'marketRole'='BUYER' AND x->>'evmAddress'=NEW."buyerAddress") OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(plan."manifest"->'participants') x WHERE x->>'userId'=NEW."sellerId"::text AND x->>'marketRole'='SELLER' AND x->>'evmAddress'=NEW."sellerAddress") THEN RAISE EXCEPTION 'allocation parties absent from manifest'; END IF;
 IF NEW."status"='CANCELLED' AND EXISTS (SELECT 1 FROM "V2SettlementIntent" WHERE "allocationId"=NEW."id") THEN RAISE EXCEPTION 'cannot cancel allocation with intent'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION "v2_intent_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a "V2Allocation"%ROWTYPE; plan "V2AllocationPlan"%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'intent facts are immutable'; END IF;
 IF TG_OP='UPDATE' AND (NEW."id",NEW."allocationId",NEW."marketId",NEW."chainId",NEW."tokenAddress",NEW."amountBaseUnits") IS DISTINCT FROM (OLD."id",OLD."allocationId",OLD."marketId",OLD."chainId",OLD."tokenAddress",OLD."amountBaseUnits") THEN RAISE EXCEPTION 'intent facts are immutable'; END IF;
 IF TG_OP='UPDATE' AND OLD."contractAddress" IS NOT NULL AND NEW."contractAddress" IS DISTINCT FROM OLD."contractAddress" THEN RAISE EXCEPTION 'intent contract is immutable once assigned'; END IF;
 PERFORM 1 FROM "V2Market" WHERE "id"=NEW."marketId" FOR UPDATE;
 SELECT * INTO a FROM "V2Allocation" WHERE "id"=NEW."allocationId" AND "marketId"=NEW."marketId" FOR UPDATE;
 IF NOT FOUND OR a."amountBaseUnits"<>NEW."amountBaseUnits" OR a."status"='CANCELLED' THEN RAISE EXCEPTION 'intent allocation mismatch'; END IF;
 SELECT * INTO plan FROM "V2AllocationPlan" WHERE "id"=a."planId" FOR UPDATE;
 IF NOT FOUND OR plan."status"<>'AUTHORITATIVE' THEN RAISE EXCEPTION 'payment requires authoritative plan'; END IF;
 RETURN NEW;
END $$;
