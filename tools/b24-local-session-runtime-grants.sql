-- Session approvals and inspection remain separate from signing and receipt verification.
GRANT SELECT,INSERT,UPDATE(status) ON "B24LocalChainSession" TO b24_approver;
GRANT SELECT ON "B24LocalChainSession" TO b24_preflight;
