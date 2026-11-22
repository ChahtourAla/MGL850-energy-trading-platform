# B26 autonomous hourly markets (offline prototype, not yet accepted)

B26 coordinates finalized B22 data, B24 synthetic authorization and B25 local settlement. It is restricted to the marker-protected disposable PostgreSQL database and registered local Hardhat sessions. No real consent, physical-delivery verification, Hedera finality or production payment authority is implied.

The worker discovers closed UTC hours with a grace period, uses a unique database run and a fenced lease, verifies the B22 snapshot and authoritative plan, and uses the accepted B24/B25 services when explicitly provisioned fixture context is supplied. The standalone CLI currently runs matching and recovery coordination without provisioning payment signers or funding; the wallet-bound integration supplies its own approved in-memory local fixture context. This limitation prevents treating the standalone CLI as a complete autonomous payment deployment.

The CLI supports `B26_SCHEDULER_MODE=MATCHING_ONLY` and a disposable `SUPERVISED_TEST` mode requiring a private parent-child IPC channel. In the latter, the parent retains the approved ephemeral signers and calls the local supervisor; the child receives no private keys. A trusted fixture provisioner can create a reservation-bound session and grant for a newly discovered allocation only when an applicable simulated policy and a separately supplied buyer, deployment, anchor and existing funding budget are approved. The B24 approver used by that fixture is a trusted principal with broader database privileges. The implementation cannot restore a lost signer supervisor or recover destroyed buyer keys.

`GET /internal/v2/market-runs`, `GET /internal/v2/market-runs/health`, and `GET /internal/v2/market-runs/:id` require the existing independent internal read key and a dedicated `b26_reporter` connection. Stored settled status and amounts are historical observations, not live chain verification; read responses explicitly mark financial summaries unverified and conservatively present paid states as requiring reconciliation.

`POST /internal/v2/market-runs/catch-up` and `POST /internal/v2/market-runs/:id/recover` require a distinct `B26_ADMIN_KEY`, a `b26_admin` connection and a UUID idempotency key. They enqueue work only; neither approves a spending policy nor authorizes payment.

See the design, security invariants, evidence and acceptance matrix for actual test boundaries and outstanding work. B26 is not independently reviewed or accepted.
