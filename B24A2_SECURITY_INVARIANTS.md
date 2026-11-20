# B24-A2 security invariants

- A `b24_preflight` session may read archived financial facts and B24 records only. It has no wallet-secret, reservation, policy, deployment, history, evidence or schema write grants.
- B22 archived source validation, manifest, identity, allocation completeness, accounting and conservation are reconciled independently of today's profiles or Python matcher.
- All authoritative allocation IDs enter the B23 plan commitment. Stored domain, terms and digest must match independently reconstructed values exactly.
- Fixture deployment and simulated policy must remain eligible; all outstanding reservation amounts count against the budget and the original nonce and deadline remain unchanged.
- Database snapshot reads cannot guarantee later signing eligibility. A future signer must recheck at its own authorization boundary, including a current clock, chain deployment, balance, allowance, nonce, customer consent and all commitments.
- Database owner, migration administrator and fixture artifact files remain trusted. The service is disposable-test only and never grants live signing permission.
