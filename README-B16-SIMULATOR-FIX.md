# B16 simulator fix — safe pre-window dry run

This patch updates the existing B16 files only. It does **not** create, sign, or submit blockchain transactions, apply Prisma migrations, or alter the B16 journal.

Previously, `--action simulate` called the `fresh:true` window guard before invoking Python, so it could not test the simulator before the delivery window. Now:

- **Outside the actual trade window**, `simulate` executes the real Python generator against **unrelated random UUIDs**, a deliberately nonreal on-chain trade ID, and a synthetic current delivery window; it validates the generator output then deletes it. The requested `--output` file is **not created**. This is a genuine Python integration dry run, not real settlement evidence.
- **Inside the actual trade window**, `simulate` continues to generate and validate real-trade evidence at `--output` using the original strict checks.
- `--action execute`, single-broadcast safeguards, explicit consent, receipt reconciliation, and the live delivery-window guard remain unchanged.

Existing future-funded trade: ID `2`, real delivery window 2026-11-11 03:00–04:00 UTC (November 10, 22:00–23:00 Toronto). Never use dry-run output to authorize real settlement.

Run `node --test apps/backend/scripts/b16-oracle-core.test.mjs` and the original `--action simulate --output b16-delivery-2.json` command before that window. Expected: `B16 SIMULATOR DRY RUN PASS`, and *no* `b16-delivery-2.json` file created. If Python isn't installed, supply `B16_PYTHON` pointing at the service's venv interpreter.
