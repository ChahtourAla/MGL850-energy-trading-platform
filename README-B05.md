# B05 — Shared Data Contracts and Validation (NestJS)

## Purpose

This overlay **does not replace** the existing Python files, JSON schemas or Prisma migration.
It adds a NestJS validator for the existing `packages/shared/schemas/*.schema.json` files (draft 2020-12), plus domain invariants, numeric/Prisma conversion helpers and a CLI.

Source reference used: `MGL850-energy-trading-platform-main(2).zip`, `packages/shared/fixtures/` and `docs/python-services-backend-contract.md`.

## Apply to your working branch

1. Verify `feature/nestjs-backend` and a clean Git working tree. Back up/inspect if `apps/backend/src/contracts` already exists.
2. Unzip this overlay to repository root. It adds only new files.
3. Install dependencies: `pnpm --filter @energy-trading/backend add ajv@^8 ajv-formats@^3`.
4. Register `ContractsModule` in `apps/backend/src/app.module.ts`:
   - import `ContractsModule` from `'./contracts/contracts.module.js'`;
   - add `ContractsModule` to the `imports` array.
5. `pnpm --filter @energy-trading/backend build`
6. `pnpm --filter @energy-trading/backend typecheck`
7. `pnpm --filter @energy-trading/backend exec vitest run src/contracts/contract-validator.spec.ts`
8. `pnpm --filter @energy-trading/backend test`
9. `pnpm --filter @energy-trading/backend lint`

## Verify against existing fixtures

From the repository root **after build**:

```powershell
node apps/backend/scripts/validate-contract.mjs user-registry packages/shared/fixtures/user-registry.sample.json
node apps/backend/scripts/validate-contract.mjs energy-snapshot packages/shared/fixtures/energy-snapshot.sample.json
node apps/backend/scripts/validate-contract.mjs matching-output packages/shared/fixtures/matching-output.sample.json packages/shared/fixtures/matching-input.sample.json
node apps/backend/scripts/validate-contract.mjs delivery-record packages/shared/fixtures/delivery-record.sample.json
```

## Negative test

```powershell
$invalid = Join-Path $env:TEMP "bad-energy-snapshot-b05.json"
'{}' | Set-Content -Encoding utf8 $invalid
node apps/backend/scripts/validate-contract.mjs energy-snapshot $invalid
if ($LASTEXITCODE -eq 0) { throw 'Invalid snapshot was incorrectly accepted' }
Remove-Item $invalid
```

## B05 boundary

- JSON Schema is the runtime source of truth. The TypeScript interfaces represent those schema payloads, but should never be used as a substitute for validation.
- Additional semantic checks align to Python Pydantic rules: energy balance, role, duplicate users, weights, match IDs, exact micro-USD floor rounding, and delivery semantics.
- `assertMatchingOutputAgainstInput` must run before B11 writes matches. Schema validation of a matching output by itself cannot detect a seller overselling source-snapshot inventory.
- Accepted JSON integers must fit JavaScript's safe integer range. Very large on-chain uint256 values require a string-based boundary in a future schema revision; never silently round them.
- Prisma mappers are only for previously validated values. No database insertion or Python process invocation in B05.
- `UserRegistry` has no passwordHash; user creation policies belong to B06/B08.
