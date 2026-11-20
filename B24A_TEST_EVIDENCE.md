# B24-A1 test evidence

Baseline `89f8c6855df6ecfe13103325894826aff5b4a258`; branch `feature/b24-wallet-authorization`. Windows Node 22.20.0 is below backend minimum 22.22.3. All database tests used newly created labeled loopback-only disposable PostgreSQL 17 containers, not persistent databases.

## Real B24 reservation

`powershell -NoProfile -ExecutionPolicy Bypass -File tools/b24a1-run-postgres-tests.ps1` applied the full migration history to an empty isolated database, ran the real B22-A generator and B22-B matcher, then authenticated separate `b24_approver` and `b24_evaluator` sessions. The existing B22 allocation `0xcb0dc67ac08cd0fda0f146ffa74c675957931d53934c104cc7aa815f58ec7a55` was 28 Wh at 90750 micro-USD/kWh. Preview wrote no rows; execution committed one reservation for **2541** base units, nonce **0**, with a bounded deadline and B23 unsigned terms; two concurrent identical requests returned the same record. Replay independently reconstructed the digest and returned that record. Fixture chain 31337 and artifact-derived fingerprints are offline test data; there is no verified Hedera deployment.

The harness rejected missing policy, nonfinal/draft market, unverified and fingerprint-mismatched deployment, insufficient limit, expired/revoked/wrong-wallet policy, tampered plan read, evaluator approval and protected-data writes, a second deployment for the same allocation, and injected precommit failure. It verified zero rows after rollback. Two independent authenticated evaluator sessions raced separate real B22 allocations for one buyer and shared policy; a lock wait was observed, only one reservation committed (4032 units) and the competing request exceeded the remaining budget. No B21 settlement intent, attempt or evidence was created. The test also preserves existing B22 correction, replay and concurrency checks. Each harness execution has a different deadline and settlement ID; no fake live address or signature was generated.

## Regression commands and results

- Full Node offline discovery across `apps/backend/scripts`, `tools`, and `packages/shared/tests`, with `B21_PYTHON` set to the local virtual environment: **1388 passed**.
- `.venv/Scripts/python.exe -m pytest --import-mode=importlib -p no:cacheprovider -q`: **608 passed**.
- Backend local `vitest.cmd run`: **171 passed**; `tsc.cmd --noEmit` and `oxlint.cmd src test`: passed.
- Root local Prisma `validate` and `generate`: passed with the additive schema.
- From `packages/contracts`, `hardhat.cmd compile --force`: **5 Solidity files compiled**, solc 0.8.34; `hardhat.cmd test --no-compile`: **88 passed** on the simulated local network.
- `tools/b21-run-postgres-tests.ps1`: initial failure because its legacy migration selection did not exclude the new B24 migration. The filter was updated to exclude B24, then the fresh and legacy-populated disposable migration checks and B21 tests passed with legacy fixture records unchanged.
- `tools/b22-run-postgres-tests.ps1`: passed with the additive migration and unchanged B22 regression scenarios.

A future independent reviewer must assess the new authorization service, database roles and the stated boundary that PostgreSQL does not recompute EVM Keccak digests. These are offline fixture results, not real consent, signing, allowance, payment or Hedera verification.

## Replay correction (2026-11-20)

The B24-A1 disposable PostgreSQL harness passed after the correction, using authenticated approver/evaluator sessions. It verified the original 2541-unit reservation and identical retry, then simulated elapsed time by substituting `Date.now` in the test process (without changing immutable rows) to separately test policy expiry and deadline expiry. It used the approver role to revoke the policy and retire the deployment. Each retry returned its specific blocked state; SQL readback proved the reservation, identity, nonce, amount and budget remained unchanged, with no second allocation reservation or nonce and no settlement intents, attempts or evidence. Read-only historical inspection remained available.

Final verification on 2026-11-20:

- PowerShell `$env:B21_PYTHON=(Resolve-Path .venv/Scripts/python.exe).Path; $tests=@(Get-ChildItem apps/backend/scripts,tools,packages/shared/tests -Recurse -File -Filter '*.test.mjs' | ForEach-Object { $_.FullName }); node --test $tests`: 1388 passed, 0 failed, 0 skipped.
- `.venv/Scripts/python.exe -m pytest --import-mode=importlib -p no:cacheprovider -q`: 608 passed.
- In `apps/backend`: `./node_modules/.bin/vitest.cmd run`: 22 files, 171 tests passed; `./node_modules/.bin/tsc.cmd --noEmit` and `./node_modules/.bin/oxlint.cmd src test`: passed.
- Root `./node_modules/.bin/prisma.cmd validate --config prisma7.config.ts` and `./node_modules/.bin/prisma.cmd generate --config prisma7.config.ts`: passed.
- `powershell -NoProfile -ExecutionPolicy Bypass -File tools/b21-run-postgres-tests.ps1`: passed fresh, representative legacy-populated, constraint and concurrency checks.
- `powershell -NoProfile -ExecutionPolicy Bypass -File tools/b22-run-postgres-tests.ps1`: passed B22-A/B22-B integration, replay, concurrency and security checks.
- `powershell -NoProfile -ExecutionPolicy Bypass -File tools/b24a1-run-postgres-tests.ps1`: passed B22 and B24-A1 integration, including replay tests above.
- In `packages/contracts`, `./node_modules/.bin/hardhat.cmd compile --force`: 5 Solidity files compiled with solc 0.8.34; `./node_modules/.bin/hardhat.cmd test --no-compile`: 88 passed. The first sandboxed compile timed out acquiring the external compiler-cache mutex; a rerun with access to the existing local cache succeeded.

All PostgreSQL harnesses used isolated containers created by their respective scripts. The B24 expiry tests use a test-process clock substitution, not elapsed real time or changes to immutable reservation records. Node v22.20.0 is below the backend's declared v22.22.3 minimum. No live blockchain operations or private-key use occurred.
