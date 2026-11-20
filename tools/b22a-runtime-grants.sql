-- Run as schema owner after the two LOGIN roles are provisioned separately.
-- The roles must not be owners, superusers, role creators, or inherit ownership.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON "B22HourlyRegistry", "B22Ingestion" FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO b22_roster,b22_ingest;
GRANT SELECT,INSERT ON "B22HourlyRegistry" TO b22_roster;
GRANT SELECT ON "B22HourlyRegistry" TO b22_ingest;
GRANT SELECT (id,name,email,physical_address,x_km,y_km,reputation,preferred_energy_type) ON users TO b22_ingest;
GRANT SELECT (id,user_id,hedera_account_id,evm_address) ON wallets TO b22_ingest;
GRANT SELECT,INSERT,UPDATE ON "V2Market", "V2Snapshot" TO b22_ingest;
GRANT SELECT,INSERT ON "V2SnapshotMeasurement", "B22Ingestion" TO b22_ingest;
GRANT SELECT ON "V2AllocationPlan" TO b22_ingest;
GRANT EXECUTE ON FUNCTION "b22_lock_profiles"(UUID[]) TO b22_ingest;
