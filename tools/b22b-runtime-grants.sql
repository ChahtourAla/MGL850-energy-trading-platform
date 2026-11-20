-- Run only by schema owner after provisioning a non-owner b22_match LOGIN.
GRANT USAGE ON SCHEMA public TO b22_match;
GRANT SELECT ON "V2Market", "V2Snapshot", "V2SnapshotMeasurement", "B22HourlyRegistry", "B22Ingestion", "V2AllocationPlan", "V2Allocation", "V2Position", "V2SettlementIntent" TO b22_match;
GRANT UPDATE (status, "updatedAt") ON "V2Market" TO b22_match;
-- B21 guards use SELECT FOR UPDATE; the B22-B trigger blocks actual snapshot updates.
GRANT UPDATE (status) ON "V2Snapshot" TO b22_match;
GRANT INSERT, UPDATE ON "V2AllocationPlan", "V2Allocation" TO b22_match;
GRANT INSERT ON "V2Position" TO b22_match;
