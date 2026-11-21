# B25 test evidence â€” accepted offline prototype

## Historical verification and intermediate results

The following entries preserve results and limitations reported at their respective points in development; they do not describe the final acceptance decision.

- `powershell -NoProfile -ExecutionPolicy Bypass -File tools/b25-run-postgres-tests.ps1`: 2 local integration tests passed after deploying 42 migrations in a new PostgreSQL 17 container. It used genuine B22 data, B24 services and B25 execution; it covered a lost broadcast response, two executor sessions, receipt recording, replay, role denials and local block reversion. The standard run includes the 2,541-unit allocation and a separate genuine two-allocation, partial-then-complete market. The first test waits through a real 15-second delayed broadcast, then revokes policy and permits that already-handed-off transaction to reach local Hardhat.
- `powershell -NoProfile -ExecutionPolicy Bypass -File tools/b24-wallet-bound-postgres.ps1`: 1 passed in a separate disposable database.
- `tools/b21-run-postgres-tests.ps1`: passed after correcting its legacy-only filter to exclude B25; no schema diff and legacy populated records remained unchanged. An earlier attempt detected B25 timestamp default drift, which was corrected.
- `tools/b22-run-postgres-tests.ps1`, `tools/b24a1-run-postgres-tests.ps1`, `tools/b24a2-run-postgres-tests.ps1`: passed in independent disposable databases.
- Node offline discovery under `apps/backend/scripts`, `tools`, `packages/shared/tests`: 1,398 passed, 0 failed.
- `.venv/Scripts/python.exe -m pytest --import-mode=importlib -p no:cacheprovider -q`: 608 passed.
- Backend Vitest: 22 files, 171 passed. Backend `tsc --noEmit` and `oxlint src test` exited successfully.
- Prisma schema validation and client generation passed. Fresh Hardhat compilation compiled 5 Solidity files with solc 0.8.34. Standalone Hardhat: 90 passing, 4 pending database-dependent tests; B24 and B25 database-dependent tests ran separately, and B24-A2 ran in its dedicated harness.

The runtime was Node 22.20.0; the backend declares >=22.22.3. No live Hedera activity, real key use or production database access occurred. These checks do not establish full B25 acceptance.

Additional B25 disposable test modes run on 2026-11-21:

- `B25_TEST_REVOKE_BEFORE_HANDOFF=1`: 1 passed, 1 multi-market test intentionally skipped; no handoff or transaction after revocation.
- `B25_TEST_RETIRE_BEFORE_HANDOFF=1`: 1 passed, 1 intentionally skipped; retirement blocked handoff.
- `B25_TEST_REVOKE_BEFORE_EXECUTE=1`: 1 passed, 1 intentionally skipped; preflight blocked without an attempt.
- `B25_TEST_NONCE_CONFLICT=1`: 1 passed, 1 intentionally skipped; an independently mined conflicting operator nonce was observed and recorded.
- `B25_TEST_LOST_HANDOFF_RESPONSE=1`: 1 passed, 1 intentionally skipped; committed handoff remained unresolved and was not broadcast on retry.
- `B25_TEST_MULTI_ONLY=1`: 1 passed; two genuine B22 allocations were settled and reconciled, with cross-deployment conflict rejected.

These results do not cover the complete requested B25 adversarial and crash/restart matrix. The verifier and local provider are trusted, and post-handoff revocation cannot cancel an in-flight transaction.

Final combined B25 run on 2026-11-21: 2 passed, 0 failed, 0 skipped. The receipt-tampering checks reject failed status, noncanonical block hash, missing settlement and token logs, modified amount, and duplicate evidence with an incorrect log index. Unauthorized operator, paused contract and restricted verifier/executor/reporter access were also exercised.

2026-11-21 follow-up: `B25_TEST_MULTI_ONLY=1; B25_TEST_REVERT=1` passed 1 real local reverted-transaction test, including failed/unpaid reporting and subsequent noncanonical evidence handling. The combined B25 suite also injects transient network, transaction, receipt and block lookup failures and requires successful recovery after restoring the provider. Separate application-process restart tests now use a persistent loopback-only Hardhat RPC; the complete requested RPC and adversarial matrix remains unverified.

Latest follow-up regression run after adding negative evidence: Node 1,398 passed; Python 608 passed; backend Vitest 22 files/171 tests passed; backend typecheck and lint exited zero; Prisma validate and generate passed; B21, B22, B24-A1, B24-A2, and B24 wallet-bound disposable harnesses passed. Fresh compilation: 5 Solidity files. Standalone Hardhat: 90 passed, 4 database-dependent tests pending; the dedicated B24, B24-A2 and B25 harnesses ran separately. B25 combined: 2 passed; B25 revert-only: 1 passed. These regression results do not establish the complete RPC/adversarial matrix.

Process recovery on 2026-11-21: set `B25_PROCESS_CRASH_POINT` to `prepared`, `handoff`, or `broadcast` and run `powershell -NoProfile -ExecutionPolicy Bypass -File tools/b25-run-postgres-tests.ps1`; each run passed 1 test. The broadcast case also terminates a verifier immediately after evidence commits, then recovers again and verifies one evidence record. The operator wallet is not recreated. Each run uses a new disposable PostgreSQL 17 container and loopback Hardhat node.

Receipt attack coverage includes altered operator, nonce, signature, buyer, seller, allocation, plan commitment and contract, an incorrect returned receipt hash, duplicate settlement logs, missing event logs and noncanonical block data. Authenticated executor, verifier and reporter role checks include denied access to wallet secrets, security triggers, policies and protected allocation records. Targeted Node B25 tests: 3 passed.

Latest targeted rerun: `powershell -NoProfile -ExecutionPolicy Bypass -File tools/b25-run-postgres-tests.ps1` passed 2 tests after binding reconciliation to the archived success block. An injected mismatch returned unresolved and zero verified paid; the normal 2,541- and 14,608-unit workflows passed. Canonical-outcome supersession and the complete acceptance matrix remain outstanding.

Fresh outcome-history verification: `B25_TEST_SUPERSESSION=1` with `tools/b25-run-postgres-tests.ps1`: 2 passed, including original success, local reorganization and the same signed transaction remined as a revert. `B25_TEST_MULTI_ONLY=1; B25_TEST_REVERT=1; B25_TEST_SUPERSESSION=1` with the same harness: 1 passed, including revert, reorganization and the same signed transaction remined as success; market accounting returned to 14,608 paid. The local test fixture, not recovery, performs the remine. Prepared, handoff and broadcast separate-process modes each passed 1 test. `node node_modules/prisma/build/index.js validate --config prisma7.config.ts` and `generate --config prisma7.config.ts` passed. Node offline suite: 1,398 passed; Python: 608 passed; backend Vitest: 171 passed; backend typecheck and lint passed. Runtime: Node 22.20.0, below backend minimum 22.22.3. These results do not cover every required attack or RPC case.

Fresh regression follow-up with outcome migration: B21 PostgreSQL passed after an initial schema-drift failure exposed missing Prisma foreign-key relations, which were added. B22 PostgreSQL, B24-A1, B24-A2 and B24 wallet-bound disposable harnesses passed. Fresh Hardhat compilation produced 5 Solidity files with solc 0.8.34; the first sandboxed compile timed out on the external compiler-cache lock, then the authorized rerun passed. Standalone Hardhat reported 90 passing and 4 database-dependent pending; those are separate harness cases.

Final focused B25 rerun after timeout handling: `B25_TEST_SUPERSESSION=1; powershell -NoProfile -ExecutionPolicy Bypass -File tools/b25-run-postgres-tests.ps1` passed 2 tests. It exercised a deliberately hung transaction lookup: reconciliation timed out unresolved, counted zero paid and retained its sole evidence event; it also exercised concurrent identical and conflicting verifier observations and SUCCESS ? NONCANONICAL ? REVERTED ? NONCANONICAL ? SUCCESS. The separate reverse-direction fixture passed 1 test. Pre-handoff revocation, deployment retirement, operator nonce conflict, revocation before execution and lost-handoff-response modes each passed 1 test with the unrelated multi-market case pending.

Additional current-run evidence: `B25_PROCESS_CRASH_POINT=revert` with `tools/b25-run-postgres-tests.ps1` passed one separate-process test. The transaction was mined status 0 after committed handoff, the verifier exited immediately after recording the outcome, and fresh verifier processes recovered one revert record with no success evidence, unchanged balances, and 2,541 unpaid. A missing block at a height still present on the provider now returns unresolved without recording noncanonical evidence. Six separately authenticated B24 runtime roles were denied B25 attempt and outcome functions.

Latest B25 supersession integration passed 2 tests with additional mutated transaction hash, sender, recipient, nonce and calldata; modified quantity, price, market, snapshot and token; and changed settlement and transfer emitters. Real receipt data was used for the successful path.

Latest B25 integration passed 2 tests with actual insufficient balance and allowance, local snapshots restoring the fixture, and two independently authenticated executor sessions using different approved local operators. Both requests resolved to one attempt. Receipt corruption tests covered altered token and event emitters.

Current follow-up: the B25 supersession integration passed 2 tests after adding missing-block handling and transaction identity attacks. The two-allocation revert-to-success reorganization passed 1 test again after recovery scan timeouts. Six B24 runtime identities were denied both B25 outcome and preparation functions. Two independent local operators raced and resolved to one durable attempt.

Further disposable B25 run: 2 tests passed with an authenticated non-executor rejected at the executor boundary, invalid session rejected, and a temporary local runtime-code change rejected before attempt creation. The SECURITY DEFINER inventory checked 11 B25 functions for fixed search paths, no public EXECUTE, and exact executor/verifier/reporter grants; prohibited B24 calls and direct mutations were also denied.

Executor read-boundary attack loop passed within the latest two-test disposable run: altered buyer, seller, energy quantity, unit price, amount, market, snapshot, buyer signature, EIP-712 chain and contract domain, token and settlement address were rejected before any attempt existed. The injected response was a copy; persisted historical data was not changed.

A fresh `B25_TEST_EXECUTOR_TIMEOUT=1; B25_TEST_SUPERSESSION=1` run passed 2 tests after eight deliberately nonreturning RPC paths: network, code, pending operator nonce, fee data, operator role, pause, buyer nonce and paid-allocation reads. Each timed out before attempt creation; normal settlement then succeeded. The suite also injects exceptions and restores the provider. Executor read-only network operations now use bounded timeouts.

A fresh `B25_TEST_EXPIRED=1` disposable run passed one test with one unrelated multi-market case pending. A genuine synthetic signed reservation reached its policy and authorization deadline; the B25 executor then rejected it without creating an attempt.

The executor was also tested with controlled `usedNonces`, `executedSettlements`, and `paidAllocations` responses. Each rejected before attempt creation; the deployed local contract state remained unchanged and the genuine settlement subsequently passed.

`B25_PROCESS_CRASH_POINT=prepared; B25_TEST_SCAN_TIMEOUT=1` passed one disposable process-restart test. Deliberately hung latest-block and full-block-scan RPC calls timed out unresolved; after restoring the provider the original attempt remained unbroadcast and no second attempt was created.

`B25_TEST_RECOVERY_TIMEOUT=1; B25_TEST_SUPERSESSION=1` passed two tests with hung network, transaction, receipt, and recorded-canonical-block lookups. Each returned unresolved while retaining one attempt and one outcome; after provider restoration, verification returned the original confirmed result.

`B25_TEST_BROADCAST_FAILURE=before` and `=after` each passed one test with one unrelated multi-market case pending. The before case made zero broadcasts and retained an unresolved handoff; the after case transmitted once, lost its response, and recovered the original local confirmation. Both retries reused the original attempt and sent nothing further.

`B25_TEST_SIGN_TIMEOUT=1; B25_TEST_SUPERSESSION=1` passed two disposable tests. An injected operator signing exception and a nonreturning local signer each left zero B25 attempts; after restoring the controlled signer the genuine settlement succeeded. No key was exported.

`B25_TEST_RETIRED_SESSION=1` passed one disposable test with one unrelated multi-market case pending: the actual chain session was retired before execution, and the executor refused to create an attempt.

`B25_TEST_CONCURRENT_CONFLICT=1` passed one test with one unrelated multi-market case pending. While one B25 execution was held after its attempt was committed, an independent operator reused the same attempt and a concurrent alternative-deployment reservation for the same allocation was rejected by B24 uniqueness. Exactly one settlement intent remained and the original payment completed once.

A further `B25_TEST_RECOVERY_TIMEOUT=1; B25_TEST_SUPERSESSION=1` run passed 2 tests after adding runtime-code lookup failures and timeouts to the already-submitted-payment recovery matrix. The original attempt and evidence remained intact and verification succeeded after provider recovery.

## Final accepted offline verification

Final fresh regression pass after the B25 implementation changes: Node 1,398 passed; Python 608 passed; backend Vitest 22 files / 171 passed; backend typecheck and lint passed; Prisma validation and Client generation passed; B21, B22, B24-A1, B24-A2 and B24 wallet-bound disposable harnesses passed; fresh Solidity compilation compiled five files with solc 0.8.34; standalone Hardhat reported 90 passing and four database-dependent pending, covered by dedicated harnesses. The B25 normal/supersession suite passed two tests; reverse supersession and each restart mode passed separately. Historical paragraphs above record earlier failures and incomplete snapshots, not the final result. Node 22.20.0 remains below the backend declared minimum of 22.22.3. All settlement activity was confined to disposable PostgreSQL and local Hardhat.
