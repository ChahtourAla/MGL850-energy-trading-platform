# Python Services — Backend Integration Contract

## 1. Purpose

The NestJS backend orchestrates the Python Data Generator and
Matching Engine through separate operating-system processes.

Communication uses JSON files following the shared schemas in
packages/shared/schemas/.

The Python services do not access PostgreSQL or Hedera.

## 2. Responsibilities

### Data Generator

- Generate static household profiles.
- Read wallet-enriched user registries.
- Simulate hourly production and consumption.
- Export validated EnergySnapshot JSON files.

### Matching Engine

- Read an EnergySnapshot or MatchingInput.
- Check buyer-seller eligibility.
- Calculate weighted matching scores.
- Allocate electricity without overselling.
- Export MatchingOutput JSON files.

### NestJS Backend

- Manage canonical users and authentication.
- Create and manage Hedera wallets securely.
- Enrich household registries after onboarding.
- Store snapshots, matches, and trades in PostgreSQL.
- Invoke the Python processes.
- Validate all returned JSON.
- Enforce timeouts and resource limits.
- Manage smart contract interactions and payments.

## 3. Data Generator CLI

Generate static users:

    python -m data_generator.cli generate-users \
      --config <user-config.json> \
      --output <users.json>

Validate an enriched registry:

    python -m data_generator.cli validate-users \
      --input <enriched-users.json> \
      --require-wallets

Generate an hourly snapshot:

    python -m data_generator.cli generate-snapshot \
      --registry <enriched-users.json> \
      --config <energy-config.json> \
      --time-slot <YYYY-MM-DDTHH:00:00Z> \
      --output-dir <directory>

The optional --consumption-only-user-id argument is repeatable.

Snapshot naming:

    energy_snapshot_YYYY-MM-DDTHH.json

Never give the Data Generator private keys.

## 4. Matching Engine CLI

Run:

    python -m matching_engine.cli \
      --input <snapshot-or-matching-input.json> \
      --config <matching-config.json> \
      --output <matching-output.json>

The Matching Engine accepts EnergySnapshot or MatchingInput.

For an EnergySnapshot, it builds MatchingInput using the
provided MatchingConfig.

For a prepared MatchingInput, its configuration must agree
with the provided MatchingConfig.

The --overwrite flag permits explicitly replacing an existing
output file, but source input/configuration files remain protected.

## 5. Matching Engine Exit Codes

- 0: Execution successful, including a market with zero matches.
- 1: Unexpected internal matching error.
- 2: Invalid input, configuration, or validation failure.
- 3: Cannot write the output file.

The backend must check the process exit code before reading results.

A successful process writes JSON to the designated output file.

Diagnostics are written to stderr; stdout is reserved and should
remain empty during normal matching execution.

## 6. Shared Data Formats

EnergySnapshot:
packages/shared/schemas/energy-snapshot.schema.json

MatchingInput:
packages/shared/schemas/matching-input.schema.json

MatchingOutput:
packages/shared/schemas/matching-output.schema.json

All backend-consumed JSON must pass the corresponding schema.

## 7. Units and Accounting

- Electricity: integer watt-hours (Wh).
- Unit prices: integer micro-USD per kWh.
- Payments: integer micro-USD.
- Distance: kilometres in the simulated coordinate system.
- Scores: floating-point values from 0 to 1.
- Time slots: UTC timestamps aligned to whole hours.
- User IDs, snapshot IDs, match IDs: UUID strings.

V1 agreed price:
seller.askPriceMicrousdPerKwh

V1 total amount:
(quantityWh * unitPriceMicrousdPerKwh) // 1000

The integer division rounds down fractional micro-USD.

The backend and blockchain payment logic must use the same
rounding convention before transferring tokens.

## 8. V1 Matching Rules

- Buyers are processed by descending required energy.
- Equal buyer demand is ordered by lexical buyer UUID.
- Sellers are ranked by weighted matching scores.
- Equal scores are resolved by price, distance, then seller UUID.
- One buyer is allocated to at most one seller.
- A buyer must be fully fulfilled; partial matching is not allowed.
- One seller may serve several buyers.
- Seller remaining inventory decreases after each match.
- No seller can allocate more electricity than its available surplus.
- Zero matches is a valid successful result.

## 9. Determinism

Given identical inputs and configuration:

- Seller/buyer allocations remain the same.
- Matching scores remain the same.
- Match IDs remain the same.

The generated createdAt timestamp may differ between runs.

The measured executionTimeMs may differ between runs.

Do not compare these two operational metadata values when
checking matching-result determinism.

## 10. Process Security and Reliability

The backend must:

1. Launch Python using an argument array, not a shell string.
2. Use an explicitly configured Python executable.
3. Use absolute paths for temporary input and output files.
4. Set a per-process execution timeout.
5. Limit the number of concurrent Python processes.
6. Capture stdout, stderr, exit code, and duration.
7. Reject outputs that fail the shared JSON Schema.
8. Verify all match users belong to the source snapshot.
9. Verify no buyer is matched twice.
10. Verify no seller's total allocation exceeds its surplus.
11. Keep private keys out of Python input/output files.
12. Delete temporary files after processing, subject to debug policy.
13. Avoid logging private keys, secrets, and sensitive account data.

The backend must not assume that a zero exit code proves that
an arbitrary result is safe to persist or execute on Hedera.

The matching output is a recommendation, not a completed trade.

## 11. Idempotency

Match IDs are deterministically derived from matching inputs.

The backend must enforce uniqueness when persisting matches
and trades and handle repeated processing of the same snapshot.

Deterministic IDs are not a replacement for database constraints
or smart contract duplicate-trade protection.

## 12. Acceptance Checks

Before backend integration:

- Python unit and cross-service tests pass.
- The standalone Python handoff smoke test passes.
- Matching input and output JSON validate against shared schemas.
- Zero-match scenarios complete with exit code 0.
- Expected quantities and monetary amounts are verified.
- No live wallets or blockchain transactions are used in tests.

## 13. Scope Limitations

The prototype does not model physical electricity transmission,
distribution-grid constraints, or actual smart-meter measurements.

It provides deterministic simulated matching recommendations.

Blockchain trade creation, escrow funding, delivery confirmation,
refunds, and settlement belong to later integration phases.
