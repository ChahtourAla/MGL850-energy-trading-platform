-- Additive B22-A audit and administrator-approved, frozen hourly rosters.
CREATE TABLE "B22HourlyRegistry" (
  "id" UUID NOT NULL PRIMARY KEY,
  "intervalStart" TIMESTAMPTZ(3) NOT NULL,
  "intervalEnd" TIMESTAMPTZ(3) NOT NULL,
  "revision" INTEGER NOT NULL,
  "profiles" JSONB NOT NULL,
  "approvedBy" VARCHAR(128) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "B22Registry_hour_check" CHECK ("revision">0 AND "intervalEnd"="intervalStart"+interval '1 hour' AND date_trunc('hour',"intervalStart" AT TIME ZONE 'UTC')="intervalStart" AT TIME ZONE 'UTC' AND jsonb_typeof("profiles")='array' AND jsonb_array_length("profiles")>0 AND length("approvedBy")>0)
);
CREATE UNIQUE INDEX "B22HourlyRegistry_intervalStart_revision_key" ON "B22HourlyRegistry"("intervalStart","revision");
CREATE INDEX "B22HourlyRegistry_intervalStart_intervalEnd_idx" ON "B22HourlyRegistry"("intervalStart","intervalEnd");
CREATE TABLE "B22Ingestion" (
  "id" UUID NOT NULL PRIMARY KEY,
  "marketId" VARCHAR(66) NOT NULL REFERENCES "V2Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "snapshotId" UUID NOT NULL UNIQUE REFERENCES "V2Snapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "registryId" UUID NOT NULL REFERENCES "B22HourlyRegistry"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "sourceIdentity" VARCHAR(128) NOT NULL,
  "sourceVersion" VARCHAR(128) NOT NULL,
  "principal" VARCHAR(128) NOT NULL,
  "configHash" VARCHAR(66) NOT NULL,
  "executableHash" VARCHAR(66) NOT NULL,
  "payloadHash" VARCHAR(66) NOT NULL,
  "contentDigest" VARCHAR(66) NOT NULL,
  "payload" JSONB NOT NULL,
  "result" VARCHAR(24) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "B22Ingestion_format_check" CHECK ("sourceIdentity"='BACKEND_LOCAL_SIMULATOR' AND "sourceVersion"='1.0.0' AND "principal"='b22_ingest' AND "result"='FINALIZED' AND "configHash" ~ '^0x[0-9a-f]{64}$' AND "executableHash" ~ '^0x[0-9a-f]{64}$' AND "payloadHash" ~ '^0x[0-9a-f]{64}$' AND "contentDigest" ~ '^0x[0-9a-f]{64}$')
);
CREATE INDEX "B22Ingestion_marketId_idx" ON "B22Ingestion"("marketId");
CREATE FUNCTION "b22_immutable_audit"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'B22 audit facts are immutable'; END $$;
CREATE TRIGGER "B22Registry_immutable" BEFORE UPDATE OR DELETE ON "B22HourlyRegistry" FOR EACH ROW EXECUTE FUNCTION "b22_immutable_audit"();
CREATE FUNCTION "b22_registry_lock"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF session_user <> 'b22_roster' THEN RAISE EXCEPTION 'authenticated roster principal required'; END IF; NEW."approvedBy":=session_user; PERFORM pg_advisory_xact_lock(hashtext('B22A_REGISTRY'),hashtext(to_char(NEW."intervalStart" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'))); RETURN NEW; END $$;
CREATE TRIGGER "B22Registry_lock" BEFORE INSERT ON "B22HourlyRegistry" FOR EACH ROW EXECUTE FUNCTION "b22_registry_lock"();
CREATE TRIGGER "B22Ingestion_immutable" BEFORE UPDATE OR DELETE ON "B22Ingestion" FOR EACH ROW EXECUTE FUNCTION "b22_immutable_audit"();
CREATE FUNCTION "b22_ingestion_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF session_user <> 'b22_ingest' THEN RAISE EXCEPTION 'authenticated ingestion principal required'; END IF;
 NEW.principal:=session_user;
 IF NOT EXISTS (SELECT 1 FROM "V2Snapshot" s JOIN "B22HourlyRegistry" r ON r.id=NEW."registryId" WHERE s.id=NEW."snapshotId" AND s."marketId"=NEW."marketId" AND s.status='FINALIZED' AND s."payloadHash"=NEW."payloadHash" AND s."configHash"=NEW."configHash" AND s."intervalStart"=r."intervalStart" AND s."intervalEnd"=r."intervalEnd") THEN RAISE EXCEPTION 'B22 ingestion snapshot or registry mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "B22Ingestion_guard" BEFORE INSERT ON "B22Ingestion" FOR EACH ROW EXECUTE FUNCTION "b22_ingestion_guard"();

-- Narrow definer operation obtains row locks without granting runtime profile updates.
CREATE FUNCTION "b22_lock_profiles"(ids UUID[]) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN PERFORM u.id FROM public.users u JOIN public.wallets w ON w.user_id=u.id WHERE u.id=ANY(ids) FOR SHARE OF u,w; END $$;
REVOKE ALL ON FUNCTION "b22_lock_profiles"(UUID[]) FROM PUBLIC;
