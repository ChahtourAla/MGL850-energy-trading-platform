-- Schema owner provisions the non-owner, non-inheriting LOGIN role separately.
GRANT USAGE ON SCHEMA public,b22_guard TO b24_preflight;
GRANT SELECT ON b22_guard.marker TO b24_preflight;
GRANT SELECT ON "V2Market", "V2Snapshot", "V2SnapshotMeasurement", "B22HourlyRegistry", "B22Ingestion", "V2AllocationPlan", "V2Allocation", "V2Position", "B24Deployment", "B24SpendingPolicy", "B24AuthorizationReservation" TO b24_preflight;
