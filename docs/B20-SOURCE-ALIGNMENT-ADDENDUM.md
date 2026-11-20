# Source alignment addendum

The requested `MGL850_P2P_Energy_Project_Proposal.pdf` and `Technical Design and Integration Specification.pdf` were not found in the repository or searched accessible parent workspace. The comparisons below were supplied by an independent reviewer; this local Codex session did not inspect the PDFs or independently verify their wording. This addendum records the project owner's approved direction without rewriting historical documents.

| Reviewer-supplied original reference | V2 alignment |
| --- | --- |
| Proposal pp. 5–7: manual energy offers/requests, escrow, simulated delivery, oracle confirmation and payment release | Superseded for new V2 allocations by automatic matching and direct post-hour settlement. |
| Technical Specification §2.3–2.5: hourly generation, buyer/seller classification and matching | Retain and extend these existing design concepts for validated, finalized historical snapshots. |
| Technical Specification §4.1 and §6: integer Wh, micro-USD pricing, six-decimal TEUSD and matching conventions | Retain these conventions; explicit rounding and dust policies remain future decisions. |
| Technical Specification §2.7–2.11 and §9.5: escrow and oracle workflow | Superseded for new V2 allocations only; historical trades retain their original terms, evidence requirements and recovery paths. |
| Technical Specification §2.2 and §10: backend-managed custodial wallets | Retain backend custody and its security controls. |
| Technical Specification §7.7 and §14: REST APIs | Extend existing APIs for the new user dashboard while preserving legacy access. |

Hedera Testnet, TEUSD, Python matching and PostgreSQL remain. Financial allocations do not demonstrate a physical delivery path; historical source data still needs validation.

B21 must add versioned snapshot/run/allocation/settlement interfaces and additive DB models. B22 must finalize snapshots and pricing. B23 requires a new direct contract, separate from legacy escrow. B24–B27 need scoped custody, worker, scheduler and read-oriented authenticated dashboard APIs; B18 legacy APIs remain available. See migration matrix for gates.
