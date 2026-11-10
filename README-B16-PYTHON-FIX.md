# B16 Python simulator integration correction

This fixes a local Python subprocess integration problem while keeping B16's oracle delivery window, journal, and settlement safeguards unchanged. **No blockchain transaction, database update, migration, or wallet activity is performed by this patch.**

## Cause and correction

The earlier B16 `--action simulate` subprocess launched `python -m data_generator.cli` in `services/data-generator`, but did not put `packages/shared/python` on `PYTHONPATH`. The generator imports `p2p_energy_shared`, a repository-local package. Without an editable Python installation, that import fails. The wrapper also hid Python stderr, so the error was difficult to diagnose.

The corrected B16 executable:

- Automatically uses the repository-root `.venv` interpreter if present (or service `.venv`), unless `B16_PYTHON` is set to an explicit interpreter executable path.
- Adds both the shared Python package source and the data-generator service source to `PYTHONPATH`, preserving the user's existing entries.
- Captures sanitized Python stderr and exit status to distinguish missing dependencies, invalid inputs, and interpreter issues.
- Preserves the pre-window **isolated synthetic dry run** and does not create real settlement evidence outside the real delivery window.

## Installation (PowerShell from repository root)

```powershell
$patch = Join-Path $HOME 'Downloads\B16-Python-simulator-integration-fix.zip'
if (-not (Test-Path $patch)) { throw 'B16 Python fix ZIP missing' }
$backup = Join-Path $env:TEMP ('b16-python-fix-backup-' + (Get-Date -Format 'yyyyMMddHHmmss'))
New-Item -ItemType Directory -Path $backup -Force | Out-Null
Copy-Item apps/backend/scripts/b16-oracle.mjs $backup
Expand-Archive -LiteralPath $patch -DestinationPath (Get-Location).Path -Force
node --check apps/backend/scripts/b16-oracle.mjs
node --test apps/backend/scripts/b16-oracle-core.test.mjs apps/backend/scripts/b16-python-runner.test.mjs
node apps/backend/scripts/b16-python-smoke.mjs
```

The smoke test runs the real Python CLI with an isolated, synthetic trade and validates its output. It needs Python 3.11+ and Pydantic 2.12+. If it reports that Pydantic is not installed, select the interpreter you used for previous Python milestones and install the existing project's dependencies into **that** interpreter. To set an interpreter explicitly in PowerShell:

```powershell
$env:B16_PYTHON = (Resolve-Path '.venv\Scripts\python.exe').Path
node apps/backend/scripts/b16-python-smoke.mjs
```

If `.venv` is absent, supply the correct path to your installed Python binary. `B16_PYTHON` must be an executable path, not a command plus options.

## Retry the guarded simulator

```powershell
Push-Location apps/backend
try {
  node --env-file=../../.env --env-file=../../packages/contracts/.env scripts/b16-oracle.mjs --match-id '60bd8ca9-bb7d-534f-8564-468e4a5f0b3a' --action simulate --output 'b16-delivery-2.json'
  if ($LASTEXITCODE -ne 0) { throw 'B16 simulation failed; no settlement action allowed' }
} finally { Pop-Location }
```

**Before November 11, 2026 03:00–04:00 UTC**, expected: `B16 SIMULATOR DRY RUN PASS`, with **no actual trade evidence output**. During the window, evidence generation is bound to the real trade; on-chain settlement still requires a separate, expressly authorized execution command.

Never rerun `--action execute` after an uncertain submission. Only `--action reconcile` may resolve an already-submitted hash.
