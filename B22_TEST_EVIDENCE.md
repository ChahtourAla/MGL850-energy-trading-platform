# B22-A verification evidence

Baseline `6f610fba5808d3cdad9abdfde57039dd29c7e3f9`, branch `feature/b22-automatic-hourly-market`. Windows, Node **22.20.0** (below backend minimum 22.22.3), Python 3.14, Prisma 7.10.0 and locally cached PostgreSQL 17. Test containers used randomly generated credentials, loopback-only dynamic ports, identity checks and owned-container cleanup. No production/shared database or live blockchain was used.

| Command | Result |
|---|---|
| `powershell -NoProfile -ExecutionPolicy Bypass -File tools/b22-run-postgres-tests.ps1` | Passed fresh 12-migration deployment and the synthetic B22-A integration harness, including role, replay, correction, rollback and the two coordinated service races. Assertions are scripted checks, not a counted unit-test suite. |
| `powershell -NoProfile -ExecutionPolicy Bypass -File tools/b21-run-postgres-tests.ps1` | Passed fresh migration/drift, B21 constraint/concurrency checks and synthetic populated legacy-data comparison. |
| `$env:B21_PYTHON=(Resolve-Path '.venv/Scripts/python.exe').Path; $tests=@(Get-ChildItem apps/backend/scripts,tools,packages/shared/tests -Filter '*.test.mjs' -File | ForEach-Object { $_.FullName }); node --test @tests` | 1,379 passed, 0 failed, 0 skipped. |
| `.venv/Scripts/python.exe -m pytest -q --import-mode=importlib -p no:cacheprovider` | 608 passed. |
| From `apps/backend`: `node_modules/.bin/vitest.cmd run` | 22 files, 171 tests passed. |
| From `apps/backend`: `node_modules/.bin/tsc.cmd --noEmit`; `node_modules/.bin/oxlint.cmd src test` | Passed. |
| `node_modules/.bin/prisma.cmd validate --config prisma7.config.ts`; `node_modules/.bin/prisma.cmd generate --config prisma7.config.ts` | Passed. |
| From `packages/contracts`: `node_modules/.bin/hardhat.cmd test --no-compile` | 68 passed. Fresh Solidity compilation was not performed. |
| `git diff --cached --check`; `git diff --check` | Passed. |

The finalization race uses a disposable test-only advisory-lock trigger to hold a competing insert until the actual B22-A service commits; the test observes the lock wait before releasing it. An immediate attempt while the snapshot is uncommitted is also rejected. The competing insertion after finalization is rejected by the B21 guard. The conflicting-ingestion case pauses one real service call after generation, allows a second authenticated service session to commit a newer approved roster revision, then confirms the stale request fails and the winner's snapshot and audit are unique.

The generator-version case uses test-scoped subprocess substitution to report version `9.0.0`, which fails closed; historical replay is also tested with generator invocation disabled and generator files unavailable. This is not an actual installed-release upgrade. The test data and output are simulated and do not establish physical delivery. See `B22_DATABASE_INVARIANTS.md` for the database boundary and limitations.
