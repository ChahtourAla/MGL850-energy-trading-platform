# B25 settlement execution â€” accepted offline prototype

B25 is accepted within the offline prototype scope. It is not ready for live Hedera. The only execution target is the marked disposable `b22_disposable_review` PostgreSQL database and a registered local Hardhat chain session. B24 consent and deployments remain synthetic.

The fixture service reconstructs the B22 allocation and B23 typed data through B24 preflight and readiness, then creates a separate local fixture intent identifier, preserving B21's chain-296 identity algorithm. A registered ephemeral operator signs and submits the B23 call only after a durable intent and a unique operator nonce/transaction hash are recorded. A retry finds the existing attempt and does not resubmit. A separate authenticated verifier checks the actual chain transaction, events and replay state before recording local evidence. The market reporter rechecks evidence against the active local chain before counting it as paid.

Run `powershell -NoProfile -ExecutionPolicy Bypass -File tools/b25-run-postgres-tests.ps1` only with Docker available. It creates and removes a uniquely labeled disposable PostgreSQL 17 container and runs a local in-process Hardhat chain. It does not contact Hedera.

The offline implementation passed independent source and evidence review. See the acceptance matrix and evidence for exact test boundaries. Do not use it as a production settlement worker.

A canonical status-0 local transaction now has separate immutable negative evidence. It is counted as failed only while its receipt remains independently verifiable; a reorganization preserves that evidence and returns the intent to unresolved. This is not a live Hedera finality claim.

The disposable integration harness exercises separate-process interruption and recovery with `B25_PROCESS_CRASH_POINT=prepared`, `handoff`, or `broadcast`. It starts a loopback-only local chain and does not connect to Hedera. The executed adversarial cases and their boundaries are recorded in the acceptance matrix.

The additive B25 outcome journal records serialized verifier-authenticated success, revert and noncanonical observations without modifying historical evidence. Disposable tests exercised both success-to-revert and revert-to-success for the same signed transaction after local reorganization; the fixture performs remine, never the recovery service. Current reporting independently checks chain evidence. The verifier and RPC are trusted; local results are not Hedera finality. The acceptance matrix records the executed local tests.
