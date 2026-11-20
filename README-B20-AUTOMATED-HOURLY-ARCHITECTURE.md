# B20: automatic hourly market architecture

The approved direction replaces new forward-looking escrow trades with automatic allocation of validated historical hourly energy and direct buyer-to-seller TEUSD settlement. It removes manual offers and delivery confirmations from the new workflow. Existing escrow trades remain governed by their existing lifecycle. Matching is financial allocation, not proof of a physical electricity path.

B20 documents the decision, target, source alignment, legacy inventory, migration and acceptance gates. It does not implement the scheduler, finalization, new contract, payment worker, top-ups or frontend. It does not change contracts, database schema, deployed artifacts or B14–B19 logic. Snapshot validation and source trust remain essential.

Read in order: [decision](docs/ADR-0001-automatic-hourly-settlement.md), [architecture](docs/ARCHITECTURE-V2-AUTOMATED-HOURLY-MARKET.md), [source alignment](docs/B20-SOURCE-ALIGNMENT-ADDENDUM.md), [legacy inventory](docs/B20-LEGACY-INVENTORY.md), [migration matrix](docs/B20-MIGRATION-MATRIX.md), and [acceptance checklist](docs/B20-ACCEPTANCE-CHECKLIST.md).

The planned flow is completed hour → validate/finalize snapshot → classify → match → check payment authority and funds → direct settlement → verify receipt/events → reconcile database → dashboard. Empty markets are normal. Uncertain transactions require reconciliation; duplicate execution must not cause duplicate payments.

Safe verification: inspect `tools/b19-run-tests.ps1` and test configurations before use. Its Hardhat task may need a local compiler cache; do not let it download dependencies or contact a live network. `node --test` on `apps/backend/scripts/*.test.mjs` and `tools/*.test.mjs` is local; Python tests can use `python -m pytest --import-mode=importlib -p no:cacheprovider packages/shared/tests packages/shared/python/tests services/data-generator/tests services/matching-engine/tests -q`. See acceptance checklist for actual results and limitations. Do not run live workflow commands as regression tests.

Open policies include source finality, pricing and dust, canonical identity encoding, correction treatment, payment authority and chain recovery. B21 starts with shared contracts and additive database design, including identity, uniqueness and evidence; it must not silently decide pricing or authorize unattended settlement.
