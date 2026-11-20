# B20 acceptance evidence

- [x] Original branch `feature/nestjs-backend`, B19 commit `e87cb3dd62c6c024fb5496758b06ebeaa40b6f10`; commit subject identifies B19. B19 implementation inspected; subject alone is not evidence of a live pass.
- [x] Existing untracked `.agents/`, `.claude/`, `.windsurf/`, `skills-lock.json` preserved. Dedicated branch created without overwriting an existing branch.
- [x] Owner approved automatic hourly/direct settlement direction; technical policies are not represented as approved.
- [x] ADR, target architecture, source addendum, inventory, matrix, checklist and README document V2, boundaries, legacy safety and B21–B28 gates.
- [x] Actual contracts, matcher, generator, schema, API and audit source inspected; deployed-state claims distinguished from repository records.
- [x] B20 commands did not request live blockchain writes, sign or change database state; legacy contracts, artifacts and migrations are not intentionally modified.
- [x] Independent architecture review completed; reviewer found the architecture sound and requested the source-alignment and accounting corrections incorporated here.
- [x] Source-document comparison supplied by the independent reviewer is recorded in the addendum. The PDFs were not available to or directly inspected by this local session.
- [x] Formal architectural acceptance recorded November 19, 2026: `B20_ARCHITECTURE_ACCEPTED`, following independent review.
- [ ] Future implementation policy decisions remain outstanding under their assigned milestone gates.
- [ ] Live legacy state independently verified; deliberately not queried in B20.
- [ ] Fresh Solidity compilation verified; the local contract tests used existing compiled artifacts.
- [ ] Backend production build verified; the B19 wrapper could not run with the available pnpm installation.
- [x] Available offline tests executed with local tools; limitations below remain explicit.

## Verification evidence

`node --test` over all `apps/backend/scripts/*.test.mjs` and `tools/*.test.mjs`: 1,327 passed, 0 failed. Python `pytest --import-mode=importlib -p no:cacheprovider` across shared and both services: 567 passed. Initial Python collection without importlib failed on three duplicate module basenames; the rerun passed. Local `vitest run`: 21 files, 170 tests passed; local Hardhat `test --no-compile`: 68 passed on simulated network using existing artifacts, so recompilation was not verified. Prisma schema validate, backend `tsc --noEmit`, oxlint, and isolated B16 Python smoke passed. The B19 wrapper was not run: PowerShell blocks `pnpm.ps1`, and `pnpm.cmd` points to a missing Corepack pnpm 12.21.0 installation. Its separate production build was not run. No installation or network repair was attempted. Final working-tree verification is recorded in the final report.

Architectural acceptance does not claim live-chain status, fresh contract compilation, a backend production build, or that B21–B28 functionality exists. Future policy gates remain open.
