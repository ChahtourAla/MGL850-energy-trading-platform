# Decentralized P2P Energy Trading Platform

A modular peer-to-peer electricity trading prototype developed
for MGL850, designed for future integration with Hedera.

The project simulates household electricity production,
consumption, energy trading recommendations, and delivery
evidence. It does not use physical smart meters or transfer
real electricity.

## Current Development Status

### Implemented

- Shared JSON Schemas and Python Pydantic models
- Synthetic household and user-registry generation
- Hourly electricity production and consumption simulation
- Buyer, seller, and neutral household classification
- Configurable energy types, prices, and scoring weights
- Greedy buyer-seller matching
- Deterministic match and delivery identifiers
- Simulated energy delivery evidence
- Python command-line interfaces
- Automated unit, integration, and performance tests
- Solidity smart contracts and Hedera deployment resources

### Not Integrated in the Current Python Subsystem

- NestJS backend and PostgreSQL persistence
- Application authentication and custodial wallet onboarding
- Oracle/gateway for validating delivery evidence
- Frontend
- Live match-to-blockchain trade execution

Smart-contract source code exists in packages/contracts/, but
the Python simulation pipeline does not invoke these contracts.

## Python Architecture

The implemented Python workflow is:

1. Generate synthetic household profiles.
2. Enrich profiles with wallet identifiers.
3. Generate hourly energy snapshots.
4. Classify participants as BUYER, SELLER or NEUTRAL.
5. Select eligible buyer-seller pairs.
6. Calculate scores, matched quantities and payments.
7. Produce proposed energy trades.
8. Simulate delivery evidence for fictional active trades.

The delivery stage requires active-trade identifiers. In the
standalone simulation, these are test-only identifiers.

## Project Structure

packages/shared/
Shared JSON Schemas, Pydantic models, and example fixtures.

services/data-generator/
Household generation, hourly energy simulation,
delivery simulation, CLI commands, configurations, and tests.

services/matching-engine/
Eligibility, scoring, greedy allocation,
output building, CLI, and integration tests.

packages/contracts/
Solidity contracts, Hardhat tests, deployment scripts,
and contract artifacts.

scripts/check_python_handoff.py
Standalone cross-service readiness verification.

docs/python-services-backend-contract.md
Shared data formats, units, commands, and integration rules.

## Python Requirements

- Python 3.11 or newer
- pip
- A Python virtual environment (recommended)

The repository also uses Node.js and pnpm for its separate
JavaScript and Solidity workspaces.

## Python Installation (Windows PowerShell)

From the repository root:

    py -3 -m venv .venv

Install the shared package and both services:

    .\.venv\Scripts\python.exe -m pip install -e .\packages\shared\python -e .\services\data-generator -e .\services\matching-engine -r .\packages\shared\requirements-dev.txt

The editable installations allow development without manually
copying Python packages.

## Available Commands

### 1. Generate Households

    .\.venv\Scripts\python.exe -m data_generator.cli generate-users --config services\data-generator\config\user-registry-config.json --output services\data-generator\output\static-users.json

This generates fictional user profiles.

Generated user profiles do not initially include Hedera wallets.

### 2. Validate a Wallet-Enriched Registry

    .\.venv\Scripts\python.exe -m data_generator.cli validate-users --input <enriched-registry.json> --require-wallets

The registry must contain valid, unique Hedera account IDs
and EVM addresses.

Wallet creation is not performed by the Data Generator.

### 3. Generate an Hourly Energy Snapshot

    .\.venv\Scripts\python.exe -m data_generator.cli generate-snapshot --registry <enriched-registry.json> --config services\data-generator\config\energy-generation-config.json --time-slot 2026-10-18T12:00:00Z --output-dir services\data-generator\output

An EnergySnapshot contains one hourly electricity record per
user, including production, consumption, net energy, market
role, price, and matching information.

The optional --consumption-only-user-id argument may be
repeated to designate households without local generation.

### 4. Run the Matching Engine

Using the included sample snapshot:

    .\.venv\Scripts\python.exe -m matching_engine.cli --input packages\shared\fixtures\energy-snapshot.sample.json --config packages\shared\fixtures\matching-config.sample.json --output services\matching-engine\output\matching-result.json

The Matching Engine writes a MatchingOutput JSON file with
selected matches, unmatched buyers, and execution metadata.

The output is a trading recommendation, not an executed trade.

### 5. Simulate Energy Delivery

    .\.venv\Scripts\python.exe -m data_generator.cli generate-delivery --input services\data-generator\fixtures\active-trade.sample.json --config services\data-generator\config\delivery-simulation-config.json --output services\data-generator\output\delivery-result.json

Supported scenarios:

- SUCCESS: expected energy was delivered.
- INCOMPLETE: delivered energy is below expected energy.
- INVALID: simulated evidence is outside the delivery window.
- MISSING: no delivery record is generated.

For MISSING, exit code 0 indicates the simulation succeeded,
but the output JSON file must not exist.

The --overwrite flag permits explicitly replacing an
existing output for record-producing scenarios.

The supplied active-trade fixture is fictional. It is not
a trade created on Hedera.

## Tests

Run every Python test:

    .\.venv\Scripts\python.exe -m pytest --import-mode=importlib packages\shared\tests packages\shared\python\tests services\data-generator\tests services\matching-engine\tests -q

Last verified baseline:

    567 passed

This baseline includes shared contracts, both Python services,
delivery scenarios, cross-service integration, and performance
tests.

## Standalone Integration Check

    .\.venv\Scripts\python.exe scripts\check_python_handoff.py

The script generates test households, adds fictional wallet
identifiers, produces energy snapshots, runs matching, and
validates the JSON interfaces.

The full simulated matching-to-delivery workflow is also
covered by:

    services/matching-engine/tests/test_delivery_end_to_end.py

## Technical Rules

- Energy quantities are integer watt-hours (Wh).
- Prices are integer micro-USD per kWh.
- Payment amounts are integer micro-USD.
- Time slots use UTC ISO 8601 timestamps.
- Locations are simulated two-dimensional kilometre coordinates.
- Buyer fulfillment must be complete in Matching V1.
- The matching algorithm must never oversell energy.
- Identical inputs produce stable allocation results and IDs.
- Delivery evidence is simulated, not physically verified.

The final implementation follows the shared data contracts
under packages/shared/.

## Security and Scope

Do not commit environment secrets, private keys, real wallet
credentials, or generated outputs containing sensitive data.

Python services do not create real Hedera transactions,
manage user private keys, or persist records in PostgreSQL.

Actual trade creation, escrow, oracle confirmation, settlement,
refunds and physical delivery verification are separate
integration responsibilities.

## Additional Documentation

See docs/python-services-backend-contract.md for the
backend-facing JSON and process integration rules.
