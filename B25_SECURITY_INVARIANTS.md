# B25 security invariants â€” accepted offline prototype

- B22/B24 financial source: B24-A2 preflight and B24 readiness independently reconstruct the archived plan, policy and signature; exercised by `B25SettlementExecution.ts`.
- Local target: B25 SQL functions require the authenticated fixture role, disposable database and marker; services also require a registered chain session. Permission-denial and unknown-session checks are exercised in the integration and Node tests.
- Duplicate attempt: unique allocation intent and one immutable local attempt per intent; unique operator/nonce and transaction hash; two independent sessions are synchronized in the integration test.
- No broadcast on retry: the executor returns the recorded attempt instead of sending it again. A simulated lost broadcast response is recovered by transaction hash in the integration test.
- Confirmation: the verifier checks transaction, calldata, block, settlement event, transfer event and replay state; only the authenticated verifier can invoke the evidence function. The integration rejects modified amount, failed receipt status, noncanonical block hash, missing settlement or transfer logs and a conflicting evidence index. The verifier/RPC remain trusted.
- Reorganization: an observed noncanonical block appends an observation and transitions the intent to `UNKNOWN`; the report no longer counts it as paid. The integration test uses a local EVM snapshot/revert.

The matrix covers the enumerated attacks; a compromised authenticated verifier or malicious RPC provider remains outside the database's independent verification boundary. The two-allocation fixture exercises partial and complete settlement and a cross-deployment reservation conflict. Do not treat these notes or the passing fixture as a production-security guarantee.

Handoff ordering: `b25_authorize_handoff` commits an immutable handoff under locks on the policy and deployment; this commit is the authorization boundary. Revocation committed first blocks handoff. A timeout after handoff is not cancellation: the transaction may still reach the chain after revocation and remains unresolved until independently verified. Tests exercise a real delayed provider, revocation after handoff, no duplicate retry, a lost handoff response, policy revocation and deployment retirement before handoff. This does not provide on-chain revocation of a transaction already handed off.

- Verified revert: `inspectRevertedSettlement` checks the signed attempt and canonical status-0 receipt; the verifier-only `b25_record_revert` rejects existing verified success evidence. `B25_TEST_REVERT=1` mines an actual paused-contract revert, verifies failed/unpaid accounting, and then removes its block through local EVM reversion. RPC access and the authenticated verifier remain trusted.

- Receipt identity: success and revert verification compare the returned receipt transaction hash to the durable attempt. The B25 integration injects a mismatched receipt hash.
- Process recovery: the disposable harness starts a separate loopback-only chain and interrupts application processes after preparation, handoff, broadcast and evidence commit. Recovery uses the durable identity without the original operator wallet.

- Success reconciliation requires the currently verified receipt block hash and log indices to match the current canonical outcome event. A mismatch remains unresolved and is not counted as paid. Canonical outcome history now records verifier-authenticated supersession; the executed adversarial cases are mapped in the acceptance matrix.

- Current outcome: `B25CanonicalOutcomeEvent` binds the immutable attempt, sequence and prior event. The verifier-only transition locks the attempt; a conflicting success or revert is accepted only after a noncanonical event. Reporting independently rechecks the current receipt. The verifier and provider remain trusted; concurrent chain changes can still occur after any local observation.

- A missing canonical-height block is not sufficient to mark evidence noncanonical while the provider reports a chain at least that high. Recovery reports unresolved and leaves the current event unchanged. The recovery scan has bounded RPC calls and an overall scan deadline.

- Executor RPC checks, nonce/fee lookup and local signing are time-bounded before attempt creation; the signed-transaction handoff retains its existing irreversible semantics. A read timeout never claims cancellation of a broadcast.
