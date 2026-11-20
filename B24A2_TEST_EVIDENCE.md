# B24-A2 test evidence

Baseline `90fe91d1608b880b00b06b578d0219d87ebb43d4`, branch `feature/b24a2-signing-preflight`. All PostgreSQL tests use newly created labeled PostgreSQL 17 containers bound to loopback, not persistent databases. Node v22.20.0 is below the backend minimum v22.22.3.

## End-to-end security checks

`powershell -NoProfile -ExecutionPolicy Bypass -File tools/b24a2-run-postgres-tests.ps1` runs real B22-A ingestion, B22-B matching, B24-A1 reservation, and B24-A2 under a separate authenticated read-only role. The real allocation is 28 Wh at 90,750 micro-USD/kWh, payment 2,541 base units, remainder zero. It checks read-only simulation eligibility, complete historical plan and commitment, typed data, unchanged reservation budget, role denials, controlled read-boundary corruption with specific rejection reasons, and a race where revocation commits after the snapshot has read the policy. The in-flight read observes the old snapshot; the next preflight rejects the revoked policy. Retirement blocks it as well.

The same harness passes the actual synthetic reserved terms to a local Hardhat subprocess. It installs local test runtime code at the fixture address on the simulated network and checks the contract's `settlementId` against the actual stored digest. This does not deploy to Hedera, sign a buyer authorization or transfer tokens. Independent time/record corruption is performed only in the test client's read boundary; accepted SQL constraints are not weakened.

## Regression commands

- Root PowerShell `$env:B21_PYTHON=(Resolve-Path .venv/Scripts/python.exe).Path; $tests=@(Get-ChildItem apps/backend/scripts,tools,packages/shared/tests -Recurse -File -Filter '*.test.mjs' | ForEach-Object { $_.FullName }); node --test $tests`: 1388 passed, 0 failed, 0 skipped.
- `.venv/Scripts/python.exe -m pytest --import-mode=importlib -p no:cacheprovider -q`: 608 passed.
- In `apps/backend`, `./node_modules/.bin/vitest.cmd run`: 22 files, 171 passed; `./node_modules/.bin/tsc.cmd --noEmit` and `./node_modules/.bin/oxlint.cmd src test`: passed.
- Root `./node_modules/.bin/prisma.cmd validate --config prisma7.config.ts` and `./node_modules/.bin/prisma.cmd generate --config prisma7.config.ts`: passed.
- `powershell -NoProfile -ExecutionPolicy Bypass -File tools/b21-run-postgres-tests.ps1`: passed, including populated legacy records.
- `powershell -NoProfile -ExecutionPolicy Bypass -File tools/b22-run-postgres-tests.ps1`: passed.
- `powershell -NoProfile -ExecutionPolicy Bypass -File tools/b24a1-run-postgres-tests.ps1`: passed.
- In `packages/contracts`, `./node_modules/.bin/hardhat.cmd compile --force`: 5 Solidity files compiled using solc 0.8.34. `./node_modules/.bin/hardhat.cmd test --no-compile`: 89 passed and 1 pending (the DB-captured digest test is run separately by the B24-A2 harness).

The tests do not establish actual user consent, on-chain deployment, allowance, balance or nonce availability. No live blockchain operation or real private key was used.
