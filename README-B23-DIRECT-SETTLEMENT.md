# B23 direct TEUSD settlement — offline review draft

The new Solidity contract uses a buyer EIP-712 signature and an operator transaction to move an exact authorized TEUSD amount directly to the seller. It uses no delivery oracle and does not settle an old escrow trade. Local fixtures demonstrate behavior only; no Hedera deployment or payment was performed.

See [design](docs/B23-DIRECT-SETTLEMENT-DESIGN.md), [security invariants](B23_SECURITY_INVARIANTS.md), and [test evidence](B23_TEST_EVIDENCE.md). `packages/contracts/src/b23-identity.ts` provides a prototype deployment-bound typed-data builder and plan commitment helper, not a production signer or a proof of PostgreSQL authority. A B22 validated authoritative plan must be checked independently before using the helper.

Offline: from `packages/contracts`, run `node_modules/.bin/hardhat.cmd compile` and `node_modules/.bin/hardhat.cmd test --no-compile`. Compilation uses installed 0.8.34. B24 must supply controlled authorization, and B25 must handle transaction journaling, receipts and reconciliation. This draft is not authorized for deployment.
