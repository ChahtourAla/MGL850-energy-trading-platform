-- Provision non-owner LOGIN roles separately, with credentials out of band.
GRANT USAGE ON SCHEMA public TO b24_approver,b24_evaluator;
GRANT SELECT,INSERT,UPDATE(status) ON "B24Deployment", "B24SpendingPolicy" TO b24_approver;
GRANT SELECT ON "V2Market", "V2Snapshot", "V2SnapshotMeasurement", "B22HourlyRegistry", "B22Ingestion", "V2AllocationPlan", "V2Allocation", "V2Position", "B24Deployment", "B24SpendingPolicy", "B24AuthorizationReservation" TO b24_evaluator;
-- SELECT FOR UPDATE on the policy requires this column privilege; trigger forbids updates.
GRANT UPDATE(status) ON "B24SpendingPolicy", "B24Deployment" TO b24_evaluator;
GRANT INSERT ON "B24AuthorizationReservation" TO b24_evaluator;
