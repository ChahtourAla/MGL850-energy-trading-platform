-- Run as the disposable test database owner after creating a LOGIN b26_worker.
GRANT USAGE ON SCHEMA public TO b26_worker;
GRANT USAGE ON SCHEMA b22_guard TO b26_worker;
GRANT SELECT ON b22_guard.marker TO b26_worker;
GRANT EXECUTE ON FUNCTION public.b26_ensure_run(uuid,timestamptz,text), public.b26_claim_run(uuid,uuid,integer), public.b26_checkpoint_run(uuid,uuid,bigint,text,varchar,varchar,varchar), public.b26_release_run(uuid,uuid,bigint,text,text,integer) TO b26_worker;
GRANT EXECUTE ON FUNCTION public.b26_renew_run(uuid,uuid,bigint,integer) TO b26_worker;
GRANT EXECUTE ON FUNCTION public.b26_due_runs(timestamptz,timestamptz,integer) TO b26_worker;

-- Reporter is read-only and receives no execution functions or financial tables.
GRANT USAGE ON SCHEMA public,b22_guard TO b26_reporter;
GRANT SELECT ON b22_guard.marker, public."B26MarketRun" TO b26_reporter;

-- The B25 receipt verifier is the only principal trusted to publish a report.
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='b25_verifier') THEN GRANT EXECUTE ON FUNCTION public.b26_record_reconciliation(uuid,uuid,bigint,jsonb) TO b25_verifier; END IF; END $$;

GRANT USAGE ON SCHEMA public,b22_guard TO b26_admin;
GRANT SELECT ON b22_guard.marker TO b26_admin;
GRANT EXECUTE ON FUNCTION public.b26_request_control(uuid,text,uuid,timestamptz,timestamptz) TO b26_admin;
GRANT EXECUTE ON FUNCTION public.b26_claim_control(uuid,integer),public.b26_complete_control(uuid,uuid,bigint) TO b26_worker;
GRANT EXECUTE ON FUNCTION public.b26_record_tick(uuid,integer) TO b26_worker;
GRANT SELECT ON public."B26WorkerHeartbeat" TO b26_reporter;

GRANT SELECT ON public."B26ControlEvent" TO b26_reporter;
