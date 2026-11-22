-- B26 offline run coordination. This migration never grants financial authority.
CREATE TABLE "B26MarketRun" (
  id uuid PRIMARY KEY,
  "intervalStart" timestamptz NOT NULL,
  "intervalEnd" timestamptz NOT NULL,
  configuration text NOT NULL CHECK (configuration = 'v1-default'),
  status text NOT NULL DEFAULT 'WAITING_FOR_DATA' CHECK (status IN ('WAITING_FOR_DATA','SNAPSHOT_FINALIZED','MATCHED','SETTLING','PARTIALLY_SETTLED','SETTLED','NO_MATCH','BLOCKED','NEEDS_RECONCILIATION')),
  "snapshotId" varchar(66), "snapshotHash" varchar(66), "planId" varchar(66),
  "workerId" uuid, fence bigint NOT NULL DEFAULT 0, "leaseUntil" timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0), retryable boolean NOT NULL DEFAULT true, "nextRetryAt" timestamptz,
  "failureCode" text, summary jsonb, "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "updatedAt" timestamptz NOT NULL DEFAULT clock_timestamp(), "completedAt" timestamptz,
  CONSTRAINT b26_hour CHECK (date_trunc('hour', "intervalStart" AT TIME ZONE 'UTC') = "intervalStart" AT TIME ZONE 'UTC' AND "intervalEnd" = "intervalStart" + interval '1 hour'),
  CONSTRAINT b26_run_unique UNIQUE ("intervalStart", configuration)
);
CREATE TABLE "B26MarketRunEvent" (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "runId" uuid NOT NULL REFERENCES "B26MarketRun"(id) ON DELETE RESTRICT ON UPDATE CASCADE, fence bigint NOT NULL,
  kind text NOT NULL, actor text NOT NULL DEFAULT session_user,
  details jsonb NOT NULL DEFAULT '{}'::jsonb, "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION b26_immutable_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'B26 events are append-only'; END $$;
CREATE TRIGGER b26_event_immutable BEFORE UPDATE OR DELETE ON "B26MarketRunEvent" FOR EACH ROW EXECUTE FUNCTION b26_immutable_event();

-- Only the named authenticated disposable worker can invoke these functions.
CREATE FUNCTION b26_check_worker() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, b22_guard AS $$
BEGIN
 IF current_database() <> 'b22_disposable_review' OR session_user <> 'b26_worker' OR
    NOT EXISTS (SELECT 1 FROM b22_guard.marker WHERE value='b22-isolated-test-only') THEN
   RAISE EXCEPTION 'B26 disposable worker required';
 END IF;
END $$;
CREATE FUNCTION b26_ensure_run(p_id uuid,p_start timestamptz,p_config text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, b22_guard AS $$
DECLARE r public."B26MarketRun";
BEGIN
 PERFORM public.b26_check_worker();
 IF p_config <> 'v1-default' OR p_start IS NULL OR p_start + interval '1 hour' > clock_timestamp() THEN RAISE EXCEPTION 'B26 interval not eligible'; END IF;
 INSERT INTO public."B26MarketRun" (id,"intervalStart","intervalEnd",configuration)
 VALUES (p_id,p_start,p_start+interval '1 hour',p_config) ON CONFLICT ("intervalStart",configuration) DO NOTHING;
 SELECT * INTO STRICT r FROM public."B26MarketRun" WHERE "intervalStart"=p_start AND configuration=p_config;
 RETURN to_jsonb(r);
END $$;
CREATE FUNCTION b26_claim_run(p_id uuid,p_worker uuid,p_seconds integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, b22_guard AS $$
DECLARE r public."B26MarketRun";
BEGIN
 PERFORM public.b26_check_worker();
 IF p_worker IS NULL OR p_seconds IS NULL OR p_seconds NOT BETWEEN 1 AND 300 THEN RAISE EXCEPTION 'B26 invalid lease'; END IF;
 UPDATE public."B26MarketRun" SET "workerId"=p_worker, fence=fence+1, "leaseUntil"=clock_timestamp()+make_interval(secs=>p_seconds), attempts=attempts+1,"updatedAt"=clock_timestamp()
 WHERE id=p_id AND ("leaseUntil" IS NULL OR "leaseUntil"<=clock_timestamp()) AND retryable AND ("nextRetryAt" IS NULL OR "nextRetryAt"<=clock_timestamp()) AND status <> 'NO_MATCH' RETURNING * INTO r;
 IF NOT FOUND THEN RETURN NULL; END IF;
 INSERT INTO public."B26MarketRunEvent" ("runId",fence,kind,details) VALUES(r.id,r.fence,'CLAIMED',jsonb_build_object('workerId',p_worker));
 RETURN to_jsonb(r);
END $$;
CREATE FUNCTION b26_renew_run(p_id uuid,p_worker uuid,p_fence bigint,p_seconds integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, b22_guard AS $$
DECLARE r public."B26MarketRun";
BEGIN
 PERFORM public.b26_check_worker();
 IF p_worker IS NULL OR p_fence IS NULL OR p_seconds IS NULL OR p_seconds NOT BETWEEN 1 AND 300 THEN RAISE EXCEPTION 'B26 invalid lease'; END IF;
 UPDATE public."B26MarketRun" SET "leaseUntil"=clock_timestamp()+make_interval(secs=>p_seconds),"updatedAt"=clock_timestamp()
 WHERE id=p_id AND "workerId"=p_worker AND fence=p_fence AND "leaseUntil">clock_timestamp() RETURNING * INTO r;
 IF NOT FOUND THEN RAISE EXCEPTION 'B26 stale worker'; END IF;
 RETURN to_jsonb(r);
END $$;
REVOKE ALL ON FUNCTION b26_renew_run(uuid,uuid,bigint,integer) FROM PUBLIC;
-- Discover previously created work whose lease/backoff has expired. The
-- worker still has to claim a fresh fence before doing any work.
CREATE FUNCTION b26_due_runs(p_from timestamptz,p_until timestamptz,p_limit integer) RETURNS SETOF jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, b22_guard AS $$
BEGIN
 PERFORM public.b26_check_worker();
 IF p_from IS NULL OR p_until IS NULL OR p_limit IS NULL OR p_from>=p_until OR p_until>clock_timestamp() OR p_limit NOT BETWEEN 1 AND 24 THEN RAISE EXCEPTION 'B26 invalid due-run query'; END IF;
 RETURN QUERY SELECT to_jsonb(r) FROM public."B26MarketRun" r
 WHERE r."intervalStart">=p_from AND r."intervalEnd"<=p_until AND r.retryable AND r.status<>'NO_MATCH'
   AND (r."leaseUntil" IS NULL OR r."leaseUntil"<=clock_timestamp())
   AND (r."nextRetryAt" IS NULL OR r."nextRetryAt"<=clock_timestamp())
 ORDER BY r."intervalStart",r.id LIMIT p_limit;
END $$;
REVOKE ALL ON FUNCTION b26_due_runs(timestamptz,timestamptz,integer) FROM PUBLIC;
CREATE FUNCTION b26_checkpoint_run(p_id uuid,p_worker uuid,p_fence bigint,p_state text,p_snapshot varchar,p_hash varchar,p_plan varchar) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, b22_guard AS $$
DECLARE r public."B26MarketRun";
BEGIN
 PERFORM public.b26_check_worker();
 SELECT * INTO STRICT r FROM public."B26MarketRun" WHERE id=p_id FOR UPDATE;
 IF r."workerId" IS DISTINCT FROM p_worker OR r.fence<>p_fence OR r."leaseUntil"<=clock_timestamp() THEN RAISE EXCEPTION 'B26 stale worker'; END IF;
 IF r."snapshotId" IS NOT NULL AND (r."snapshotId" IS DISTINCT FROM p_snapshot OR r."snapshotHash" IS DISTINCT FROM p_hash) THEN RAISE EXCEPTION 'B26 snapshot changed'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public."V2Snapshot" s JOIN public."V2Market" m ON m.id=s."marketId" WHERE s.id::text=p_snapshot AND s.status='FINALIZED' AND s."payloadHash"=p_hash AND m."intervalStart"=r."intervalStart" AND m."intervalEnd"=r."intervalEnd") THEN RAISE EXCEPTION 'B26 snapshot not finalized for interval'; END IF;
 IF p_state='SNAPSHOT_FINALIZED' AND r.status IN ('WAITING_FOR_DATA','SNAPSHOT_FINALIZED','BLOCKED') THEN NULL;
 ELSIF p_state='MATCHED' AND r.status IN ('SNAPSHOT_FINALIZED','MATCHED','BLOCKED','NEEDS_RECONCILIATION','SETTLED','PARTIALLY_SETTLED') AND EXISTS (SELECT 1 FROM public."V2AllocationPlan" p WHERE p.id=p_plan AND p."snapshotId"::text=p_snapshot AND p.status='AUTHORITATIVE') THEN NULL;
 ELSIF p_state='NO_MATCH' AND r.status='SNAPSHOT_FINALIZED' AND EXISTS (SELECT 1 FROM public."V2AllocationPlan" p WHERE p.id=p_plan AND p."snapshotId"::text=p_snapshot AND p.status='AUTHORITATIVE') AND NOT EXISTS (SELECT 1 FROM public."V2Allocation" a WHERE a."planId"=p_plan) THEN NULL;
 ELSE RAISE EXCEPTION 'B26 invalid checkpoint'; END IF;
 IF r."planId" IS NOT NULL AND r."planId" IS DISTINCT FROM p_plan THEN RAISE EXCEPTION 'B26 plan changed'; END IF;
 UPDATE public."B26MarketRun" SET status=p_state,"snapshotId"=p_snapshot,"snapshotHash"=p_hash,"planId"=COALESCE(p_plan,"planId"),"updatedAt"=clock_timestamp() WHERE id=p_id RETURNING * INTO r;
 INSERT INTO public."B26MarketRunEvent" ("runId",fence,kind) VALUES(r.id,r.fence,p_state);
 RETURN to_jsonb(r);
END $$;
CREATE FUNCTION b26_release_run(p_id uuid,p_worker uuid,p_fence bigint,p_state text,p_code text,p_retry_seconds integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, b22_guard AS $$
DECLARE r public."B26MarketRun";
BEGIN
 PERFORM public.b26_check_worker();
 SELECT * INTO STRICT r FROM public."B26MarketRun" WHERE id=p_id FOR UPDATE;
 IF r."workerId" IS DISTINCT FROM p_worker OR r.fence<>p_fence OR r."leaseUntil"<=clock_timestamp() THEN RAISE EXCEPTION 'B26 stale worker'; END IF;
 IF p_state NOT IN ('WAITING_FOR_DATA','BLOCKED','MATCHED','NEEDS_RECONCILIATION','NO_MATCH') OR p_retry_seconds NOT BETWEEN -1 AND 3600 OR p_code !~ '^[A-Z_]{1,64}$' THEN RAISE EXCEPTION 'B26 invalid release'; END IF;
 IF p_state='WAITING_FOR_DATA' AND r."snapshotId" IS NOT NULL THEN RAISE EXCEPTION 'B26 cannot discard snapshot'; END IF;
 IF p_state IN ('MATCHED','NEEDS_RECONCILIATION') AND r."planId" IS NULL THEN RAISE EXCEPTION 'B26 plan missing'; END IF;
 IF p_state='NO_MATCH' AND r.status<>'NO_MATCH' THEN RAISE EXCEPTION 'B26 no-match checkpoint required'; END IF;
 UPDATE public."B26MarketRun" SET status=p_state,"failureCode"=NULLIF(p_code,'NONE'),"workerId"=NULL,"leaseUntil"=NULL,retryable=(p_retry_seconds>=0),"nextRetryAt"=CASE WHEN p_retry_seconds<=0 THEN NULL ELSE clock_timestamp()+make_interval(secs=>p_retry_seconds) END,"updatedAt"=clock_timestamp(),"completedAt"=CASE WHEN p_state='NO_MATCH' THEN clock_timestamp() ELSE NULL END WHERE id=p_id RETURNING * INTO r;
 INSERT INTO public."B26MarketRunEvent" ("runId",fence,kind,details) VALUES(r.id,r.fence,'RELEASED',jsonb_build_object('state',p_state,'reason',p_code));
 RETURN to_jsonb(r);
END $$;
-- The independently authenticated B25 verifier is trusted to recheck local RPC
-- before supplying a report. PostgreSQL verifies identities and arithmetic but
-- cannot independently establish blockchain canonicality.
CREATE FUNCTION b26_record_reconciliation(p_id uuid,p_worker uuid,p_fence bigint,p_report jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, b22_guard AS $$
DECLARE r public."B26MarketRun"; item jsonb; a public."V2Allocation"; n integer; seen integer; confirmed integer:=0; pending integer:=0; failed integer:=0; unresolved integer:=0; expected numeric:=0; paid numeric:=0; wh numeric:=0; current_outcome text; intent_status text; next_state text;
BEGIN
 IF session_user<>'b25_verifier' OR current_database()<>'b22_disposable_review' OR NOT EXISTS(SELECT 1 FROM b22_guard.marker WHERE value='b22-isolated-test-only') THEN RAISE EXCEPTION 'B26 verifier required' USING ERRCODE='42501'; END IF;
 SELECT * INTO STRICT r FROM public."B26MarketRun" WHERE id=p_id FOR UPDATE;
 IF r."workerId" IS DISTINCT FROM p_worker OR r.fence<>p_fence OR r."leaseUntil"<=clock_timestamp() OR r.status<>'MATCHED' OR r."planId" IS NULL THEN RAISE EXCEPTION 'B26 stale reconciliation'; END IF;
 IF jsonb_typeof(p_report->'allocations') IS DISTINCT FROM 'array' OR p_report->>'simulationOnly' IS DISTINCT FROM 'true' OR p_report->>'realHederaExecutionAuthorized' IS DISTINCT FROM 'false' OR p_report->>'marketId' IS DISTINCT FROM (SELECT "marketId" FROM public."V2AllocationPlan" WHERE id=r."planId" AND status='AUTHORITATIVE') THEN RAISE EXCEPTION 'B26 invalid report'; END IF;
 SELECT count(*) INTO n FROM public."V2Allocation" WHERE "planId"=r."planId" AND status='VALIDATED';
 SELECT count(DISTINCT value->>'allocationId') INTO seen FROM jsonb_array_elements(p_report->'allocations');
 IF n<>jsonb_array_length(p_report->'allocations') OR seen<>n OR n=0 THEN RAISE EXCEPTION 'B26 incomplete report'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p_report->'allocations') LOOP
  SELECT * INTO a FROM public."V2Allocation" WHERE id=item->>'allocationId' AND "planId"=r."planId" AND status='VALIDATED';
  IF NOT FOUND OR item->>'expectedBaseUnits' IS DISTINCT FROM a."amountBaseUnits"::text OR item->>'quantityWh' IS DISTINCT FROM a."quantityWh"::text THEN RAISE EXCEPTION 'B26 allocation report mismatch'; END IF;
  expected:=expected+a."amountBaseUnits"; wh:=wh+a."quantityWh";
  IF item->>'state'='CONFIRMED_LOCAL' THEN
   SELECT i.status,o.outcome INTO intent_status,current_outcome FROM public."V2SettlementIntent" i JOIN public."B25LocalAttempt" t ON t."intentId"=i.id JOIN LATERAL (SELECT outcome FROM public."B25CanonicalOutcomeEvent" WHERE "attemptId"=t.id ORDER BY sequence DESC LIMIT 1) o ON true WHERE i."allocationId"=a.id;
   IF intent_status IS DISTINCT FROM 'CONFIRMED' OR current_outcome IS DISTINCT FROM 'SUCCESS' OR item->>'paidBaseUnits' IS DISTINCT FROM a."amountBaseUnits"::text THEN RAISE EXCEPTION 'B26 payment evidence mismatch'; END IF;
   confirmed:=confirmed+1; paid:=paid+a."amountBaseUnits";
  ELSE
   IF item->>'paidBaseUnits' IS DISTINCT FROM '0' THEN RAISE EXCEPTION 'B26 unverified payment'; END IF;
   CASE item->>'state' WHEN 'PENDING' THEN pending:=pending+1; WHEN 'FAILED' THEN failed:=failed+1; WHEN 'UNRESOLVED' THEN unresolved:=unresolved+1; ELSE RAISE EXCEPTION 'B26 invalid allocation state'; END CASE;
  END IF;
 END LOOP;
 IF p_report->>'matchedWh' IS DISTINCT FROM wh::text OR p_report->>'expectedBaseUnits' IS DISTINCT FROM expected::text OR p_report->>'verifiedPaidBaseUnits' IS DISTINCT FROM paid::text OR p_report->>'unpaidBaseUnits' IS DISTINCT FROM (expected-paid)::text OR p_report->>'confirmed' IS DISTINCT FROM confirmed::text OR p_report->>'pending' IS DISTINCT FROM pending::text OR p_report->>'failed' IS DISTINCT FROM failed::text OR p_report->>'unresolved' IS DISTINCT FROM unresolved::text THEN RAISE EXCEPTION 'B26 aggregate report mismatch'; END IF;
 next_state:=CASE WHEN unresolved>0 THEN 'NEEDS_RECONCILIATION' WHEN confirmed=n THEN 'SETTLED' WHEN paid>0 THEN 'PARTIALLY_SETTLED' ELSE 'BLOCKED' END;
 UPDATE public."B26MarketRun" SET status=next_state,summary=jsonb_build_object('matchedWh',wh::text,'expectedBaseUnits',expected::text,'verifiedPaidBaseUnits',paid::text,'unpaidBaseUnits',(expected-paid)::text,'confirmed',confirmed,'pending',pending,'failed',failed,'unresolved',unresolved),"failureCode"=CASE WHEN next_state='SETTLED' THEN NULL ELSE 'PAYMENT_INCOMPLETE' END,"workerId"=NULL,"leaseUntil"=NULL,retryable=(next_state IN ('SETTLED','NEEDS_RECONCILIATION')),"nextRetryAt"=CASE WHEN next_state IN ('SETTLED','NEEDS_RECONCILIATION') THEN clock_timestamp()+interval '60 seconds' ELSE NULL END,"updatedAt"=clock_timestamp(),"completedAt"=CASE WHEN next_state='SETTLED' THEN clock_timestamp() ELSE NULL END WHERE id=p_id RETURNING * INTO r;
 INSERT INTO public."B26MarketRunEvent" ("runId",fence,kind,details) VALUES(r.id,r.fence,'RECONCILED',jsonb_build_object('state',next_state));
 RETURN to_jsonb(r);
END $$;
REVOKE ALL ON FUNCTION b26_record_reconciliation(uuid,uuid,bigint,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION b26_check_worker(),b26_ensure_run(uuid,timestamptz,text),b26_claim_run(uuid,uuid,integer),b26_checkpoint_run(uuid,uuid,bigint,text,varchar,varchar,varchar),b26_release_run(uuid,uuid,bigint,text,text,integer) FROM PUBLIC;

-- Administrative requests are queue entries, never payment authorization.
CREATE TABLE "B26ControlRequest" (
 id uuid PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('CATCH_UP','RECOVER')),
 "runId" uuid REFERENCES "B26MarketRun"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 "intervalStart" timestamptz, "intervalEnd" timestamptz,
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','CLAIMED','DONE')),
 "claimedBy" uuid, fence bigint NOT NULL DEFAULT 0, "leaseUntil" timestamptz,
 "requestedBy" text NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
 "updatedAt" timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE "B26ControlEvent" (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 "requestId" uuid NOT NULL REFERENCES "B26ControlRequest"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 fence bigint NOT NULL, kind text NOT NULL, actor text NOT NULL DEFAULT session_user,
 "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER b26_control_event_immutable BEFORE UPDATE OR DELETE ON "B26ControlEvent" FOR EACH ROW EXECUTE FUNCTION b26_immutable_event();
CREATE FUNCTION b26_request_control(p_id uuid,p_kind text,p_run uuid,p_start timestamptz,p_end timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,b22_guard AS $$
DECLARE q public."B26ControlRequest";
BEGIN
 IF session_user<>'b26_admin' OR current_database()<>'b22_disposable_review' OR NOT EXISTS(SELECT 1 FROM b22_guard.marker WHERE value='b22-isolated-test-only') THEN RAISE EXCEPTION 'B26 admin required' USING ERRCODE='42501'; END IF;
 IF p_id IS NULL OR p_kind NOT IN ('CATCH_UP','RECOVER') THEN RAISE EXCEPTION 'B26 invalid control request'; END IF;
 IF p_kind='CATCH_UP' AND (p_run IS NOT NULL OR p_start IS NULL OR p_end IS NULL OR p_start>=p_end OR p_end>clock_timestamp() OR p_end-p_start>interval '24 hours' OR date_trunc('hour',p_start AT TIME ZONE 'UTC')<>p_start AT TIME ZONE 'UTC' OR date_trunc('hour',p_end AT TIME ZONE 'UTC')<>p_end AT TIME ZONE 'UTC') THEN RAISE EXCEPTION 'B26 invalid catch-up range'; END IF;
 IF p_kind='RECOVER' AND (p_run IS NULL OR p_start IS NOT NULL OR p_end IS NOT NULL OR NOT EXISTS(SELECT 1 FROM public."B26MarketRun" WHERE id=p_run)) THEN RAISE EXCEPTION 'B26 invalid recovery target'; END IF;
 INSERT INTO public."B26ControlRequest"(id,kind,"runId","intervalStart","intervalEnd","requestedBy") VALUES(p_id,p_kind,p_run,p_start,p_end,session_user) ON CONFLICT(id) DO NOTHING;
 IF FOUND THEN
  INSERT INTO public."B26ControlEvent"("requestId",fence,kind) VALUES(p_id,0,'REQUESTED');
  IF p_kind='RECOVER' THEN
   UPDATE public."B26MarketRun" SET retryable=true,"nextRetryAt"=NULL,"updatedAt"=clock_timestamp() WHERE id=p_run;
   INSERT INTO public."B26MarketRunEvent"("runId",fence,kind,details) SELECT id,fence,'RECOVERY_REQUESTED',jsonb_build_object('requestId',p_id) FROM public."B26MarketRun" WHERE id=p_run;
  END IF;
 END IF;
 SELECT * INTO STRICT q FROM public."B26ControlRequest" WHERE id=p_id;
 IF q.kind IS DISTINCT FROM p_kind OR q."runId" IS DISTINCT FROM p_run OR q."intervalStart" IS DISTINCT FROM p_start OR q."intervalEnd" IS DISTINCT FROM p_end THEN RAISE EXCEPTION 'B26 conflicting control request'; END IF;
 RETURN to_jsonb(q);
END $$;
CREATE FUNCTION b26_claim_control(p_worker uuid,p_seconds integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,b22_guard AS $$
DECLARE q public."B26ControlRequest";
BEGIN
 PERFORM public.b26_check_worker();
 IF p_worker IS NULL OR p_seconds IS NULL OR p_seconds NOT BETWEEN 1 AND 300 THEN RAISE EXCEPTION 'B26 invalid control lease'; END IF;
 SELECT * INTO q FROM public."B26ControlRequest" WHERE status='PENDING' OR (status='CLAIMED' AND "leaseUntil"<=clock_timestamp()) ORDER BY "createdAt",id FOR UPDATE SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 UPDATE public."B26ControlRequest" SET status='CLAIMED',"claimedBy"=p_worker,fence=fence+1,"leaseUntil"=clock_timestamp()+make_interval(secs=>p_seconds),"updatedAt"=clock_timestamp() WHERE id=q.id RETURNING * INTO q;
 INSERT INTO public."B26ControlEvent"("requestId",fence,kind) VALUES(q.id,q.fence,'CLAIMED');
 RETURN to_jsonb(q) || jsonb_build_object('targetStart',CASE WHEN q.kind='RECOVER' THEN (SELECT "intervalStart" FROM public."B26MarketRun" WHERE id=q."runId") ELSE q."intervalStart" END);
END $$;
CREATE FUNCTION b26_complete_control(p_id uuid,p_worker uuid,p_fence bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,b22_guard AS $$
BEGIN
 PERFORM public.b26_check_worker();
 UPDATE public."B26ControlRequest" SET status='DONE',"leaseUntil"=NULL,"updatedAt"=clock_timestamp() WHERE id=p_id AND status='CLAIMED' AND "claimedBy"=p_worker AND fence=p_fence AND "leaseUntil">clock_timestamp();
 IF NOT FOUND THEN RAISE EXCEPTION 'B26 stale control lease'; END IF;
 INSERT INTO public."B26ControlEvent"("requestId",fence,kind) VALUES(p_id,p_fence,'COMPLETED');
END $$;
REVOKE ALL ON FUNCTION b26_request_control(uuid,text,uuid,timestamptz,timestamptz),b26_claim_control(uuid,integer),b26_complete_control(uuid,uuid,bigint) FROM PUBLIC;

CREATE TABLE "B26WorkerHeartbeat" (
 "workerId" uuid PRIMARY KEY, "lastTickAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
 "ticks" bigint NOT NULL DEFAULT 0, "lastIntervalCount" integer NOT NULL DEFAULT 0
);
CREATE FUNCTION b26_record_tick(p_worker uuid,p_count integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,b22_guard AS $$
BEGIN
 PERFORM public.b26_check_worker();
 IF p_worker IS NULL OR p_count IS NULL OR p_count NOT BETWEEN 0 AND 1000 THEN RAISE EXCEPTION 'B26 invalid tick'; END IF;
 INSERT INTO public."B26WorkerHeartbeat"("workerId","ticks","lastIntervalCount") VALUES(p_worker,1,p_count)
 ON CONFLICT("workerId") DO UPDATE SET "lastTickAt"=clock_timestamp(),"ticks"=public."B26WorkerHeartbeat"."ticks"+1,"lastIntervalCount"=p_count;
END $$;
REVOKE ALL ON FUNCTION b26_record_tick(uuid,integer) FROM PUBLIC;

-- A B26 market may reach B25 preparation/handoff only under its current lease.
-- The row lock is held only for the B25 database statement, never during RPC.
CREATE FUNCTION b26_guard_settlement_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,b22_guard AS $$
DECLARE iid text; r public."B26MarketRun";
BEGIN
 IF TG_TABLE_NAME='B25LocalAttempt' THEN iid:=NEW."intentId";
 ELSE SELECT "intentId" INTO iid FROM public."B25LocalAttempt" WHERE id=NEW."attemptId"; END IF;
 SELECT x.* INTO r FROM public."V2SettlementIntent" i JOIN public."V2Market" m ON m.id=i."marketId" JOIN public."B26MarketRun" x ON x."intervalStart"=m."intervalStart" AND x."intervalEnd"=m."intervalEnd" AND x.configuration='v1-default' WHERE i.id=iid FOR SHARE OF x;
 IF FOUND AND (r.status<>'MATCHED' OR r."leaseUntil" IS NULL OR r."leaseUntil"<=clock_timestamp() OR r.id::text IS DISTINCT FROM current_setting('b26.run_id',true) OR r."workerId"::text IS DISTINCT FROM current_setting('b26.worker_id',true) OR r.fence::text IS DISTINCT FROM current_setting('b26.fence',true)) THEN RAISE EXCEPTION 'B26 stale execution fence'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION b26_guard_settlement_fence() FROM PUBLIC;
CREATE TRIGGER b26_attempt_fence BEFORE INSERT ON "B25LocalAttempt" FOR EACH ROW EXECUTE FUNCTION b26_guard_settlement_fence();
CREATE TRIGGER b26_handoff_fence BEFORE INSERT ON "B25DispatchHandoff" FOR EACH ROW EXECUTE FUNCTION b26_guard_settlement_fence();
