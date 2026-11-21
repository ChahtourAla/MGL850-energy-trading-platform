GRANT USAGE ON SCHEMA public,b22_guard TO b24_allowance;
GRANT SELECT ON b22_guard.marker TO b24_allowance;
GRANT EXECUTE ON FUNCTION "b24_prepare_local_allowance"(UUID,UUID,BIGINT,BIGINT),"b24_lock_local_allowance"(UUID),"b24_submit_local_allowance"(UUID,TEXT) TO b24_allowance;
GRANT EXECUTE ON FUNCTION "b24_mark_local_unresolved"(TEXT,UUID) TO b24_allowance;
GRANT EXECUTE ON FUNCTION "b24_attach_local_submission"(TEXT,UUID,TEXT) TO b24_allowance;
GRANT EXECUTE ON FUNCTION "b24_local_recovery_context"(TEXT,UUID) TO b24_allowance;
