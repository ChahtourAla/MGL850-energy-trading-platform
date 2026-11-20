# Migration matrix and milestone gates

Actions describe the target, not work completed in B20. All gates require tests and preserve legacy records.

| Component / actual path | Responsibility; action | Milestone and dependencies | Risk / acceptance gate |
| --- | --- | --- | --- |
| `packages/shared/schemas/`, `packages/shared/python/` | Current JSON/Python handoff; EXTEND | B21; V2 boundary and identifiers | Versioned compatible contracts, units, canonical hash vectors and invalid input tests. |
| `services/data-generator/` | Simulates energy and roles; EXTEND | B22; B21 contracts | Complete, provenance-bearing finalized snapshots; repeatability and invalid/late data tests. |
| `services/matching-engine/` | Eligibility, scoring, greedy full-buyer matching; EXTEND | B22; finalized input | Quantity conservation, compatible terms, deterministic output and empty market tests. |
| `apps/backend/` | Imports, auth, custody and legacy APIs; EXTEND | B24–B27; B21–B23 | Isolated services, least privilege and recovery tests. |
| `database/schema.prisma`, `database/migrations/` | Existing persistence; EXTEND | B21; versioned contracts | Additive migration, uniqueness and rollback/compatibility tests with legacy data. |
| `apps/backend/src/wallets/` | Custodial wallet provisioning and encryption; EXTEND | B24; authorization design | Backend-only keys, scoped authorization, revocation and audit tests. |
| `packages/contracts/contracts/TestEnergyUSD.sol` | Six-decimal token; KEEP | B23/B24; existing artifact | Confirm network and token identity; controlled mint, no public unrestricted mint. |
| `packages/contracts/contracts/EnergyTradingEscrow.sol` | Escrow lifecycle; LEGACY | B23; preserve historical operations | No state conversion; old obligations and ABI remain recoverable. |
| `apps/backend/src/hedera-contracts/`, `packages/shared/contracts/` | Deployment and chain read integration; EXTEND | B23/B25; deployment identity | Receipt/event provenance and network checks; no legacy artifact replacement. |
| `apps/backend/scripts/b16-oracle*.mjs` | Delivery confirmation; LEGACY | B23; isolation from V2 | No delivery oracle required for V2; retain old evidence path. |
| `database/schema.prisma` B14/B16/B17 intents; `apps/backend/scripts/b14-*`, `b17-*` | Signed transaction and recovery journals; EXTEND | B25; B21/B23 | Separate V2 journal, unique identity, unknown outcome and restart tests. |
| `apps/backend/src/auth/` | JWT authentication; EXTEND | B27; B24 | Participant isolation, authorization and no secret exposure. |
| `apps/backend/src/trading-api/` | B18 participant reads and internal preflight; KEEP | B27; additive API | Historical endpoints remain compatible; V2 reads independently scoped. |
| `apps/backend/scripts/b19-audit*.mjs` | Cross-layer legacy audit; EXTEND | B28; B25 evidence | Independent V2 invariants plus unchanged legacy audit; distinguish confirmed from unknown. |
| Scheduler (no current component) | Hourly orchestration; NEW | B26; B22/B25 | Unique interval, concurrent lease, restart, no replay including accelerated mode. |
| Direct contract (no current component) | Direct buyer-to-seller transfer; NEW | B23; B21 ID design | Access, replay, transfer atomicity, pause and adversarial tests. |
| Frontend (no current `apps/frontend`) | User dashboard; NEW | B27; B24–B26 | Participant views, confirmed totals, accessible UI and controlled top-up. |

## Ordered handoff

- **B21:** freeze compatible V2 shared data contracts, canonical encoding/hash test vectors, UTC interval and identity namespaces; additive DB migration, uniqueness/locking, immutable provenance, correction linkage, per-allocation intent and evidence, legacy migration tests. No financial implementation.
- **B22:** source finalization and validated completed snapshots; matching conservation/empty results; versioned pricing, rounding, dust, late data and corrections policy approved and tested before payment.
- **B23:** separate contract, independently reviewed settlement identity/domain, buyer authorization integration, events, replay guard, roles and security tests. Depends on B21 identity and B22 monetary policy.
- **B24:** custodial authorization lifecycle, constrained allowances/signing, revocation, controlled test-token top-up quotas and audit. Requires B23 authority model.
- **B25:** durable worker, exact-transaction journal, receipt/event validation and reconciliation, uncertainty and partial settlement tests. Requires B21–B24.
- **B26:** scheduler, lease/restart/recovery and accelerated mode with distinct interval identities. Requires B22/B25.
- **B27:** ownership-scoped authenticated dashboard APIs and Next.js interface; requires B21/B24–B26.
- **B28:** end-to-end and adversarial tests, controlled Hedera Testnet demonstration, performance measurements and independent final audit. Requires all earlier gates and explicit live-operation authorization.
