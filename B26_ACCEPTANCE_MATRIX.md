# B26 acceptance matrix (working evidence)

| Requirement | Enforcing code and executed evidence | Result |
| --- | --- | --- |
| UTC, grace, bounded batches and calendar boundaries | `b26-utc-hours.mjs`; `node --test apps/backend/scripts/b26-utc-hours.test.mjs` (4 tests) | PASS |
| Run uniqueness, separate workers and stale checkpoint fencing | B26 migration; `tools/b26-run-postgres-tests.ps1` | PASS |
| B22 finalized snapshot and matching | `b26-market-worker.mjs`; `tools/b26-run-postgres-tests.ps1` | PASS |
| B24/B25 exact local settlement and duplicate attempt protection | `b26-local-payment.mjs`; `tools/b26-wallet-bound-postgres.ps1` | PASS |
| Stale-worker fence at B25 preparation and handoff | B26 trigger and B25 executor; `B26_TEST_HANDOFF_RACE=1` and normal 24-hour harness | PASS |
| Post-handoff revocation and delayed local broadcast | `B26_TEST_POST_HANDOFF_RACE=1` with B26 wallet-bound harness | PASS |
| Authenticated API read/admin separation and validation | `b26-market-runs.http.spec.ts`; backend Vitest targeted run | PASS |
| Admin idempotency, database role restrictions and audit | `tools/b26-run-postgres-tests.ps1` | PASS |
| Read-only preview does not change plans, reservations or intents | `tools/b26-b22-postgres.mjs` via B26 PostgreSQL harness | PASS |
| 24 distinct hours, no duplicate local payment | `tools/b26-wallet-bound-postgres.ps1`; 14 no-match, nine blocked, one 2,541-unit settlement | PASS |
| Genuine multi-allocation run, partial then complete | `B25MultiAllocation.ts` through `tools/b26-wallet-bound-postgres.ps1`: 10,624 paid initially, then 14,608 total across two attempts | PASS |
| Existing reservation discovery | `b26-authorization-discovery.mjs`; multi-allocation wallet-bound harness resolves persisted reservation and rechecks B24 policy; session and grant remain separately provisioned | PASS (existing reservations only) |
| Unreserved policy preview fails closed without local capability | `b26-authorization-discovery.mjs`; `B25MultiAllocation.ts` via `tools/b26-wallet-bound-postgres.ps1` verifies no reservation is created | PASS (preview only) |
| Recovery after policy revocation | `b26-authorization-discovery.mjs`; `B25MultiAllocation.ts` via `tools/b26-wallet-bound-postgres.ps1` reconciles existing attempt after policy revocation and verifies attempt count | PASS (existing attempt only) |
| Restore recorded public session for recovery | `b26-authorization-discovery.mjs`; `B25MultiAllocation.ts` via `tools/b26-wallet-bound-postgres.ps1` drops the in-memory session and restores the same session for an existing attempt | PASS (in-process loss only) |
| Local supervisor request and stale fence | `b26-payment-supervisor.mjs`; `B25MultiAllocation.ts` via `tools/b26-wallet-bound-postgres.ps1` performs two settlements and rejects a stale worker | PASS (in-process fixture only) |
| Authenticated renewal and stale token rejection | `b26_renew_run`; `tools/b26-run-postgres-tests.ps1` tests current, wrong-worker, expired and reporter calls | PASS (database boundary) |
| Separate payment-capable scheduler and new policy discovery | `B25MultiAllocation.ts` via `tools/b26-wallet-bound-postgres.ps1` settles one previously unreserved allocation through a forked scheduler using a preapproved synthetic policy, local anchor and funding budget | PASS (one allocation, trusted fixture approver) |
| Six or more payable hours in an unattended 24-hour run | `B26SixPayableHours.ts`; `$env:B26_SIX_HOURS_ONLY='1'; powershell -NoProfile -ExecutionPolicy Bypass -File tools/b26-wallet-bound-postgres.ps1`; six genuine exact-payment hours, 18 no-match hours, six attempts; the scheduler is interrupted after three payments and a new process completes the remaining hours using the same fixture supervisor | PASS (fixture contains no blocked hour; separate mixed-state fixture covers blocked drafts) |
| Interrupted catch-up returns to expired work | `b26_due_runs` and `processDueMarketRuns`; `tools/b26-run-postgres-tests.ps1` checks bounded discovery and role denial, and the six-hour test reclaims an expired in-progress run | PASS (other crash stages remain unverified) |
| Lease renewal across all requested long-running payment stages | Renewal and fencing implemented; all controlled long-delay stage tests remain outstanding | NOT RUN |
| Worker lease interruption and process restart; handoff and broadcast recovery | B26 restart worker scripts and `B26_TEST_CRASH_AFTER_HANDOFF/BROADCAST` modes | PASS |
| Noncanonical local receipt and conservative reporting | B26 wallet-bound harness; `b26-market-runs.service.spec.ts` | PASS |
| Full signer-process restart followed by signing a new, previously unsigned allocation | In-memory B24 registry cannot be reconstructed from a restarted process without a custody or signer-supervision mechanism. | NOT VERIFIED |
| Complete B26-specific RPC, funding, allowance and multi-allocation adversarial matrix | Individual inherited B24/B25 protections are exercised, but not every requested case is tested through B26. | NOT VERIFIED |
| Separate-process crash at every B26 checkpoint and complete 24-hour paid catch-up | Some process boundaries and one authorized payment are covered; every requested checkpoint and funding state is not. | NOT VERIFIED |
| Full B21-B25 and all dedicated regression modes after every final change | Selected suites passed; final exhaustive rerun is not complete. | NOT VERIFIED |

Node 22.20.0 is below the backend's declared 22.22.3 minimum. No live Hedera transaction is authorized by these tests.
