# B22-B test evidence ? implementation awaiting independent review

Checkpoint: `441b636f81a5b9a0d5c8ea65caf806f257ed61f4`. All PostgreSQL tests use locally created, labeled, loopback-only disposable Docker PostgreSQL 17 containers; no persistent database or Hedera network is used.

## Exact scenario

The unmodified B22-A simulator with the approved seven-person test roster at `2026-10-03T12:00:00Z` generated snapshot `564c6c5b-5ada-5660-ac74-9ec51422ebea`. One match: 28 Wh ? 90750 micro-USD/kWh / 1000 = 2541 base units, remainder 0. Plan `0xc09614b57a3346b96cc3a8e294516038fa2c0921603639c92b665612770ea24b` transitioned DRAFT ? AUTHORITATIVE, allocation PLANNED ? VALIDATED; database readback verified manifest hash, seven positions, 28 Wh bought and sold, one authoritative plan, zero intents. A concurrent identical request reused the plan. A subsequent replay succeeded while the Python subprocess was forced to throw.

A separate 155 Wh ? 94068 market produced 14580 base units, remainder 540, and remained a DRAFT. Injection immediately before allocation insert, validation and authorization each rolled back all plan, allocation and position rows; retry succeeded. A second plan activation was rejected by the B21 unique index. Authenticated `b22_match` was denied roster, ingestion audit, snapshot, measurement and settlement writes, schema creation and trigger disabling.

## Commands and final results

- `powershell -NoProfile -ExecutionPolicy Bypass -File tools/b22-run-postgres-tests.ps1`: PASS: migrations, B22-A regression, B22-B exact/dust/concurrency/replay/rollback, roles, 5 corrupted Python outputs, incomplete-draft quarantine and correction rejection.
- `powershell -NoProfile -ExecutionPolicy Bypass -File tools/b21-run-postgres-tests.ps1`: PASS: fresh and legacy-populated migration and B21 safety checks; legacy fixture records unchanged.
- `node --test --test-reporter=dot` with `apps/backend/scripts` and `tools` test files: exit 0; 1375 tests were counted by the preceding full TAP run; dot reporter does not emit a count.
- `.venv/Scripts/python.exe -m pytest --import-mode=importlib -p no:cacheprovider -q`: 608 passed.
- Backend `.\node_modules\.bin\vitest.cmd run`: 171 passed in 22 files; `tsc.cmd --noEmit` and `oxlint.cmd src test`: exit 0.
- Root local Prisma `validate` and `generate`: exit 0. Contract local Hardhat `test --no-compile`: 68 passed using existing artifacts.

Node 22.20.0 is below the backend's declared 22.22.3 minimum; no system installation was changed. The package manager Corepack shim is unavailable; local binaries were used.

## Outstanding

See final verification addendum below.

## Final verification addendum

`tools/b22-run-postgres-tests.ps1` passed the full-buyer-fulfillment replay test, overlapping independently configured service calls with different manifest hashes, rollback/recovery, matching-role permissions, correction and unknown-draft checks. Wrong wallet and manifest hash were rejected by the matching/plan triggers; wrong quotient and remainder by `V2Allocation_terms_check`. Each injected SQL error rolled back plans, allocations and positions and left zero intents. Five corrupted Python results were rejected before plan insertion.

`apps/backend/scripts/b22b-safety.test.mjs` adds four pure trust-boundary tests: duplicate buyer, excess/partial buyer quantity, aggregate seller overselling, incompatible energy type, wallet mismatch, and zero-base-unit rejection by the V1 Python output validator. These run without database access, so they cannot write a plan or intent. The B21 PostgreSQL harness independently exercises duplicate logical allocations and related SQL integrity.

Node discovery: the old 1,375 command searched `apps/backend/scripts,tools`; the B22-A 1,379 command additionally included `packages/shared/tests`, whose `b21-v2.test.mjs` contains four tests. The final command includes all three directories and the four new B22-B safety tests: **1,383 passed**. Python: 608 passed; backend Vitest: 171; Hardhat offline `--no-compile`: 68. Typecheck, lint, Prisma validate and generate passed. The B21 disposable harness initially encountered a database startup shutdown and passed on retry, including unchanged populated legacy fixtures.

Node 22.20.0 is below the backend's declared 22.22.3 minimum. The alternate matching configuration is only reachable behind the existing disposable-database guard; it is not a production configuration management system. The matcher-output attack tests cover the named invariants at the existing pure validator boundary; they do not establish future exactly-once settlement or exercise Hedera.
