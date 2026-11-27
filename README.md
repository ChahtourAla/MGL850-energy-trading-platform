# MGL850 — Generate, import, match, and open the selected day

This release replaces the previous `RUN_MGL850_DAY.ps1` with the same **single PowerShell entry point**, plus one tightly-scoped dashboard component update. Use the same script for both preview and commit. The original source of wallet keys or approvals is never included.

## What happens after import

When `-Mode CommitMatching` finishes successfully, the script reads the existing NestJS API and checks:

- all **12 newly generated households** are in the active simulated-user list (dedicated database assumed);
- all **24 hours** have an imported energy snapshot;
- all **24 hours** have a matching decision;
- **each** of the 12 households has exactly **24 visible energy readings**;
- the dashboard's actual daily API response corresponds to the selected UTC day.

It creates a local verification record at `%LOCALAPPDATA%\MGL850\simulation-days\YYYY-MM-DD\dashboard-verification.json` and opens the correct day in the browser. If Next.js is not already running on port 3000, it starts `pnpm --dir apps/frontend dev` in a separate command window, then opens the page.

The dashboard enhancement (installed **only if you pass `-UpdateDashboard`**) adds the number of *matches found* and the explicit message **"Matches proposed — not paid"**, instead of showing an unhelpful "Needs review" for fresh, unmatched-by-payment Python results. The existing user's payment history remains independent, and only verified on-chain payments can be labeled *Paid*.

## Prerequisites

1. Run **in the cloned Git repository root** on your teammate's Windows computer, on the latest `feature/b26-autonomous-hourly-market-runs` commit containing the B36/B37 dashboard and B34 day-coverage API.
2. `pnpm install`, Python virtualenv and its requirements installed, PostgreSQL running, Prisma migrations applied.
3. New households (e.g. 12) **already imported** in the teammate's *own, dedicated PostgreSQL database*, with a verified Hedera Testnet wallet for every generated user. The stored original `users.json` must not contain wallet keys or fabricated addresses.
4. Root `.env` has valid `DATABASE_URL`, `INTERNAL_IMPORT_API_KEY`, and `TRADING_API_READ_ADMIN_KEY` (>=32 chars). The **frontend** also needs working `B27_BACKEND_URL=http://127.0.0.1:3001` and exactly the same `TRADING_API_READ_ADMIN_KEY` via `apps/frontend/.env.local` or its normal environment.
5. Backend is started via `pnpm --dir apps/backend start:dev` on port 3001. This script checks `/health/ready` before importing.
6. Do **not** copy keys or the database from the first machine. You don't need operator/private signing keys to generate and match data, but each simulated household must have its verified wallet record as required by the import API.

## Extract the ZIP

```powershell
Expand-Archive -LiteralPath "$HOME\Downloads\MGL850_DAY_VISIBLE_RELEASE.zip" -DestinationPath "$HOME\Downloads\MGL850_DAY_VISIBLE_RELEASE" -Force

$runner = "$HOME\Downloads\MGL850_DAY_VISIBLE_RELEASE\RUN_MGL850_DAY.ps1"
$registry = Join-Path $env:LOCALAPPDATA 'MGL850\new-simulation\users.json'
```

## 1. Preview a NEW day (no DB changes)

```powershell
& $runner -Day '2026-11-27' -RegistryPath $registry -EnergySeed 20271127 -UpdateDashboard
```

`-UpdateDashboard` first checks the exact known B36 dashboard source and creates a backup. If it is different, the runner stops rather than overwriting local modifications. The new panel passes local TypeScript validation or is restored automatically. This is a **frontend code change**, not a database or blockchain change.

The preview produces exactly 24 immutable JSON snapshots and a `preview-manifest.json`. Inspect them before proceeding. Preview never imports energy or creates payments, and **will not show new energy data in the dashboard yet**.

## 2. Import, match, verify the dashboard, and open the day

```powershell
& $runner -Day '2026-11-27' -RegistryPath $registry -EnergySeed 20271127 -Mode CommitMatching -UpdateDashboard
```

When prompted, type the exact approval `IMPORT_AND_MATCH_2026-11-27`.

The script imports the same immutable snapshots, records matching decisions for all 24 hours (including legitimate zero-match hours), checks the **actual backend dashboard read APIs**, and then opens `http://localhost:3000/?day=2026-11-27&userId=<generated-id>`.

**Do not change `-Day`, `-EnergySeed`, the original registry, or the energy config between preview and commit.** The same day cannot be re-previewed with a different dataset.

## What to expect on-screen

- Household names and energy history graph for the chosen day.
- 24 energy readings per household, *if all validations passed*.
- Daily overview: "Hours with energy data 24/24", "Hours processed 24/24", "Matches found N", "Hours without matches X".
- Rows with matches but no Hedera settlement: **"Matches proposed — not paid"**.
- The "More details" page contains the matching history for the selected household.
- **No new TEUSD payments**. The main Electricity Trading History will not show paid transactions until a separate, secure and date-independent settlement workflow has actually completed.

## Important safety boundaries

- The previously approved Hedera settlement scripts were tied to the original 2026-11-10 market and wallet set. They **cannot** be replayed for arbitrary days/new users. This runner's `-Mode SettleTestnet` intentionally refuses to broadcast.
- This workflow never claims physical electricity delivery.
- If the import or matching stops partway through, do not discard the saved artifacts or rerun with a new seed. Investigate the partial DB state and source hash first.
- Use the original latest GitHub dashboard component. If the source differs, merge the new component manually instead of bypassing its file-hash guard.
- Windows-specific commands and a running local PostgreSQL/Hedera environment have **not** been executed in this build environment. The TypeScript panel syntax and package integrity have been checked here; the full Windows run must still be validated on your teammate's machine.

## Optional flags

- `-NoBrowser` skips automatic browser opening.
- `-NoFrontendAutoStart` won't start Next.js; it prints the URL if port 3000 is not available.
- Omit `-UpdateDashboard` to leave the frontend code unchanged (data will still be available through the current energy charts, but the daily summary may label proposed matches less clearly).
