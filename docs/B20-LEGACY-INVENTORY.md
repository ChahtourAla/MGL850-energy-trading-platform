# Legacy inventory: source evidence, not a live audit

Baseline `e87cb3dd62c6c024fb5496758b06ebeaa40b6f10`. No live RPC or database query was performed. All live addresses, balances, permissions, trade status and obligations are **NOT VERIFIED**; the following are repository artifacts and historical claims only.

| Component | Source and observed behavior |
| --- | --- |
| TEUSD | `packages/contracts/contracts/TestEnergyUSD.sol`: ERC-20, six decimals; `DEFAULT_ADMIN_ROLE`, `MINTER_ROLE`; restricted mint. |
| Escrow | `packages/contracts/contracts/EnergyTradingEscrow.sol`: `DEFAULT_ADMIN_ROLE`, `OPERATOR_ROLE`, `ORACLE_ROLE`, `PAUSER_ROLE`; external trade ID uniqueness, buyer allowance/balance, escrow funding, oracle confirmation then seller transfer, cancellation/expiry/refund. Contract calculation floors `Wh * microUSD/kWh / 1000`; V2 dust policy is unresolved. |
| Deployment | `packages/shared/contracts/deployments/hedera-testnet.json` and `packages/contracts/ignition/deployments/chain-296/deployed_addresses.json` agree on chain 296: TEUSD `0x9Ada96be34382a1554C0bE4Fb35cC010C05A5C7c`; escrow `0xf60d732EA588499D6984179B6F60f80b2FD67e5D`. Artifacts are not proof of current deployment state. Retain chain-296 and failed-backup ignition journals and ABIs. |
| B14/B15 | `apps/backend/scripts/b14-*.mjs`, `b15-trade-sync*.mjs`: guarded funding intents and receipt checks; B15 syncs verified chain data to Trade. Preserve five B14 operation records and identity linkage. |
| B16 | `apps/backend/scripts/b16-oracle*.mjs`, generator delivery simulator: evidence validation, oracle intent and settlement; isolated simulation is not genuine evidence. |
| B17 | `apps/backend/scripts/b17-recovery*.mjs`: guarded cancellation, expiration and refund with separate operator journal. |
| B18 | `apps/backend/src/trading-api/`: participant-scoped JWT reads and internal guarded preflight; no HTTP execution of settlement. |
| B19 | `apps/backend/scripts/b19-audit*.mjs`: cross-layer checks; read-only audit tool exists, but no live audit was run in B20. |
| Persistence | `database/schema.prisma` defines Trade, DeliveryRecord, BlockchainTransaction, EnergySnapshotImport, MatchingRun and B14/B16/B17 intent journals. Retain migrations and exact transaction references for reconciliation. |

`README-B15-UNIFIED.md` identifies historical match `60bd8ca9-bb7d-534f-8564-468e4a5f0b3a`, external ID `0xcf7dd5496d70fc9010f07f177c85869f52fb3d3d8200220a628bc1a10e931f07`, on-chain trade 2. `README-B19-UNIFIED.md` describes it as funded awaiting delivery at the time of that report; current status is **UNKNOWN**. Do not modify it, invent evidence, or infer that it has been settled/refunded. Historical records and authorized legacy recovery remain necessary regardless of V2.
