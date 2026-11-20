-- B21 triggers lock snapshots while checking financial records. Column UPDATE
-- privilege is required for PostgreSQL row locks; this guard rejects actual writes.
CREATE FUNCTION "b22b_deny_matching_snapshot_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF session_user = 'b22_match' THEN RAISE EXCEPTION 'matching role cannot modify snapshots' USING ERRCODE='42501'; END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER "B22B_no_matching_snapshot_mutation" BEFORE UPDATE OR DELETE ON "V2Snapshot" FOR EACH ROW EXECUTE FUNCTION "b22b_deny_matching_snapshot_mutation"();
