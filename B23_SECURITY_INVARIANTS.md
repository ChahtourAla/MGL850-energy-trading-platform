# B23 security invariants and limits

- Exact buyer authorization: EIP-712 binds the complete settlement struct, chain ID and contract; only operator submits. Local signer/domain/tampering cases are tested.
- One allocation per deployment: `paidAllocations`, digest and per-buyer nonce mappings. No global duplicate prevention across deployments.
- One plan per market per deployment: the plan and snapshot pin occurs in the same atomic transaction as the first transfer. The plan commitment is not an on-chain membership proof and is not a PostgreSQL authority proof.
- Exact payment: positive int64-bound integers, exact division; balance deltas match the intended amount. Fee/revert/false-return mock transfers revert and revert all state. The token must still be independently trusted.
- Role controls: admin, operator and pauser begin distinct; pauser may pause/unpause. Constructor checks token code and decimals; address is immutable. Admin role compromise remains serious.
- Reentrancy: the settlement entry point is nonReentrant; tested with a callback token granted the operator role.
- Tests do not establish Hedera finality, real consent, secure custodial key management or cross-deployment idempotency. Do not use this offline draft for live operations before independent audit and B24/B25 design.
