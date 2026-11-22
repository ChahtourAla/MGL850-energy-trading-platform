# B26 security invariants

- `b26_ensure_run` and the unique interval/configuration constraint prevent duplicate logical runs. Claims and checkpoints are serialized, expire, and require the current fencing token.
- `b26_guard_settlement_fence` enforces the active B26 fence at both B25 attempt insertion and handoff. The minimal B25 executor change supplies and clears the session fence inside its existing connection lock. B25 retains its original revocation and uncertain-submission semantics.
- B26 cannot approve B24 policies, alter B22 financial history, or write B25 confirmation evidence. B25's separate verifier is trusted to check local-chain evidence before `b26_record_reconciliation`; the database validates membership and exact arithmetic, not the RPC's honesty.
- The reporter and admin database identities are separate. The read API requires its own internal key; control requests require a different key, have idempotent identifiers and cannot directly change financial state.
- The dry run uses B22 read/preview functions only. It does not sign, fund, approve or settle. Missing authorization remains blocked.
- Current canonicality is not guaranteed by a stored status. Read-only API responses flag stored amounts as unverified, and reorganization recovery returns previously paid amounts to unresolved until rechecked.

The offline prototype uses synthetic consent and ephemeral local wallets. It does not establish physical energy delivery, real customer consent or Hedera finality. See the acceptance matrix for remaining untested scenarios.
