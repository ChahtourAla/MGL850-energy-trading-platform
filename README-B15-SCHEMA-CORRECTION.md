# B15 safe schema-parser correction (same B15 milestone)

This targeted replacement updates only two B15 files. It fixes the Prisma schema parser's handling of fields such as `deliveryRecords DeliveryRecord[]` and retains strict refusal of unknown required scalar fields.

Changes:
- `b15-trade-sync-core.mjs`: correct regex suffix matching; classify arrays as nonrequired and keep unknown required scalars required.
- `b15-trade-sync-core.test.mjs`: three regression tests for inverse list relation, optional relation, and unknown required scalar.

The executable `b15-trade-sync.mjs` is unchanged. No migration, wallet-key access or Hedera transaction is involved. Run the core tests and read-only preview before authorizing DB synchronization.
