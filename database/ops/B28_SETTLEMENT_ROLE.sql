-- B28 testnet-only settlement journal. Run on energy_trading as energy_admin.
-- Does not modify V2 financial tables or relax B22/B25 constraints.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='b28_hedera_writer') THEN
  CREATE ROLE b28_hedera_writer NOLOGIN NOINHERIT;
 END IF;
END $$;
GRANT CONNECT ON DATABASE energy_trading TO b28_hedera_writer;
GRANT USAGE ON SCHEMA public TO b28_hedera_writer;
GRANT SELECT ON public."V2Market",public."V2Snapshot",public."V2Allocation",public."V2AllocationPlan" TO b28_hedera_writer;
GRANT SELECT,INSERT ON public."V2SettlementIntent",public."V2SettlementAttempt",public."V2SettlementEvidence" TO b28_hedera_writer;
GRANT UPDATE (status,"updatedAt") ON public."V2SettlementIntent" TO b28_hedera_writer;
GRANT UPDATE (status,"updatedAt") ON public."V2SettlementAttempt" TO b28_hedera_writer;
GRANT b28_hedera_writer TO energy_admin;
