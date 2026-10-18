
"""
Large-market performance and backend-handoff tests.

Uses validated shared models and the existing
Matching Engine implementation.

Checks:
- Hundreds of buyers and sellers
- No energy overselling
- Full buyer fulfillment
- Deterministic input-order-independent results
- Valid MatchingOutput JSON
- Markets without buyers or sellers
- Real subprocess CLI execution

No blockchain, database or network operations.
"""

import json
import subprocess
import sys
import time

from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5

import pytest

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

from p2p_energy_shared import (
    MatchingInput,
    MatchingOutput,
)

from matching_engine.greedy import match_greedily
from matching_engine.output_builder import build_matching_output


ROOT = Path(__file__).resolve().parents[3]

FIXTURES = ROOT / "packages" / "shared" / "fixtures"
SCHEMAS = ROOT / "packages" / "shared" / "schemas"

INPUT_FIXTURE = FIXTURES / "matching-input.sample.json"
CONFIG_FIXTURE = FIXTURES / "matching-config.sample.json"

FIXED_TIME = datetime(
    2026, 10, 18, 12, 0, 0,
    tzinfo=timezone.utc,
)

BUYER_DEMAND_WH = 1000
SELLER_SUPPLY_WH = 10000
SELLER_ASK_PRICE = 140000
BUYER_MAX_PRICE = 170000


# --------------------------------------------------
# 1. Read JSON
# --------------------------------------------------

def read_json(path):
    return json.loads(
        Path(path).read_text(encoding="utf-8")
    )


# --------------------------------------------------
# 2. Create deterministic test identities
# --------------------------------------------------

def identity(role, number):

    user_id = uuid5(
        NAMESPACE_URL,
        f"p2p-performance:{role}:{number}:user",
    )

    record_id = uuid5(
        NAMESPACE_URL,
        f"p2p-performance:{role}:{number}:record",
    )

    wallet_number = (
        number + 1
        if role == "buyer"
        else number + 10001
    )

    return {
        "userId": str(user_id),
        "recordId": str(record_id),
        "evmAddress": f"0x{wallet_number:040x}",
    }


# --------------------------------------------------
# 3. Construct a large validated MatchingInput
# --------------------------------------------------

def make_market(
    buyer_count: int,
    seller_count: int,
) -> MatchingInput:

    raw = read_json(INPUT_FIXTURE)

    buyer_template = next(
        user
        for user in raw["users"]
        if user["marketRole"] == "BUYER"
    )

    seller_template = next(
        user
        for user in raw["users"]
        if user["marketRole"] == "SELLER"
    )

    users = []

    # ----------------------------------------------
    # A. Create sellers
    # ----------------------------------------------

    for number in range(seller_count):

        seller = dict(seller_template)

        seller.update(
            identity("seller", number)
        )

        seller.update({
            "productionWh": 11000,
            "consumptionWh": 1000,
            "netEnergyWh": SELLER_SUPPLY_WH,
            "availableEnergyWh": SELLER_SUPPLY_WH,
            "requiredEnergyWh": 0,
            "marketRole": "SELLER",
            "energyType": "SOLAR",
            "askPriceMicrousdPerKwh": SELLER_ASK_PRICE,
            "maxPriceMicrousdPerKwh": None,
            "xKm": 2.0,
            "yKm": 2.0,
            "reputation": 92,
            "preferredEnergyType": "ANY",
        })

        users.append(seller)

    # ----------------------------------------------
    # B. Create buyers
    # ----------------------------------------------

    for number in range(buyer_count):

        buyer = dict(buyer_template)

        buyer.update(
            identity("buyer", number)
        )

        buyer.update({
            "productionWh": 0,
            "consumptionWh": BUYER_DEMAND_WH,
            "netEnergyWh": -BUYER_DEMAND_WH,
            "availableEnergyWh": 0,
            "requiredEnergyWh": BUYER_DEMAND_WH,
            "marketRole": "BUYER",
            "energyType": None,
            "askPriceMicrousdPerKwh": None,
            "maxPriceMicrousdPerKwh": BUYER_MAX_PRICE,
            "xKm": 2.0,
            "yKm": 2.0,
            "reputation": 75,
            "preferredEnergyType": "ANY",
        })

        users.append(buyer)

    raw["snapshotId"] = str(
        uuid5(
            NAMESPACE_URL,
            f"p2p-performance:{buyer_count}:{seller_count}",
        )
    )

    raw["users"] = users

    return MatchingInput.model_validate(raw)


# --------------------------------------------------
# 4. Execute matching and output construction
# --------------------------------------------------

def execute_market(market):

    start = time.perf_counter()

    plan = match_greedily(market)

    output = build_matching_output(
        market,
        plan,
        created_at=FIXED_TIME,
    )

    elapsed_seconds = (
        time.perf_counter() - start
    )

    return plan, output, elapsed_seconds


# ==================================================
# TEST 1 — Scale and allocation conservation
# ==================================================

@pytest.mark.parametrize(
    "buyer_count,seller_count",
    [
        (25, 3),
        (100, 10),
        (300, 30),
        (400, 30),
    ],
)
def test_market_scale_and_energy_conservation(
    buyer_count,
    seller_count,
):

    market = make_market(
        buyer_count,
        seller_count,
    )

    before = market.model_dump_json(
        by_alias=True
    )

    plan, output, elapsed = execute_market(market)

    # Each seller can fulfill ten buyers.
    expected_matched = min(
        buyer_count,
        seller_count * 10,
    )

    assert len(output.matches) == expected_matched

    assert len(output.unmatched_buyer_ids) == (
        buyer_count - expected_matched
    )

    # Every matched buyer receives its full demand.
    assert all(
        match.quantity_wh == BUYER_DEMAND_WH
        for match in output.matches
    )

    # No buyer can be matched twice.
    matched_ids = [
        match.buyer_id
        for match in output.matches
    ]

    assert len(matched_ids) == len(set(matched_ids))

    # ----------------------------------------------
    # Verify conservation per seller
    # ----------------------------------------------

    allocated = defaultdict(int)

    for match in output.matches:
        allocated[match.seller_id] += (
            match.quantity_wh
        )

    for seller_id, quantity in allocated.items():
        assert quantity <= SELLER_SUPPLY_WH

        assert plan.remaining_by_seller_wh[
            seller_id
        ] == SELLER_SUPPLY_WH - quantity

    assert sum(allocated.values()) == (
        expected_matched * BUYER_DEMAND_WH
    )

    # Payment uses the seller ask price.
    assert all(
        match.unit_price_microusd_per_kwh
        == SELLER_ASK_PRICE
        for match in output.matches
    )

    assert all(
        match.total_amount_microusd == 140000
        for match in output.matches
    )

    # Matching must never change the input.
    assert market.model_dump_json(
        by_alias=True
    ) == before

    print(
        f"\nMarket: {buyer_count} buyers, "
        f"{seller_count} sellers"
        f"\nMatches: {len(output.matches)}"
        f"\nUnmatched: {len(output.unmatched_buyer_ids)}"
        f"\nExecution: {elapsed:.4f} seconds"
    )


# ==================================================
# TEST 2 — Input order cannot change allocations
# ==================================================

def test_large_market_is_order_independent():

    market = make_market(125, 15)

    raw = market.model_dump(
        mode="json",
        by_alias=True,
    )

    raw["users"].reverse()

    reversed_market = MatchingInput.model_validate(
        raw
    )

    first_plan, first_output, _ = execute_market(
        market
    )

    second_plan, second_output, _ = execute_market(
        reversed_market
    )

    assert first_plan == second_plan

    assert first_output.model_dump_json(
        by_alias=True
    ) == second_output.model_dump_json(
        by_alias=True
    )


# ==================================================
# TEST 3 — Large JSON output validates and reloads
# ==================================================

def test_large_output_schema_and_round_trip():

    market = make_market(130, 15)

    _, output, _ = execute_market(market)

    encoded = output.model_dump_json(
        by_alias=True,
        indent=2,
    )

    reloaded = MatchingOutput.model_validate_json(
        encoded
    )

    assert reloaded == output

    registry = Registry()

    for path in sorted(
        SCHEMAS.glob("*.schema.json")
    ):
        schema = read_json(path)

        registry = registry.with_resource(
            schema["$id"],
            Resource.from_contents(schema),
        )

    output_schema = read_json(
        SCHEMAS / "matching-output.schema.json"
    )

    validator = Draft202012Validator(
        output_schema,
        registry=registry,
        format_checker=FormatChecker(),
    )

    validator.validate(
        json.loads(encoded)
    )


# ==================================================
# TEST 4 — Many buyers but zero sellers
# ==================================================

def test_large_market_without_sellers():

    market = make_market(
        buyer_count=300,
        seller_count=0,
    )

    _, output, _ = execute_market(market)

    assert output.matches == []

    assert len(output.unmatched_buyer_ids) == 300

    assert len(set(output.unmatched_buyer_ids)) == 300


# ==================================================
# TEST 5 — Many sellers but zero buyers
# ==================================================

def test_large_market_without_buyers():

    market = make_market(
        buyer_count=0,
        seller_count=100,
    )

    plan, output, _ = execute_market(market)

    assert output.matches == []
    assert output.unmatched_buyer_ids == []

    assert len(
        plan.remaining_by_seller_wh
    ) == 100

    assert all(
        quantity == SELLER_SUPPLY_WH
        for quantity
        in plan.remaining_by_seller_wh.values()
    )


# ==================================================
# TEST 6 — Real CLI works with a large market
# ==================================================

def test_large_market_via_cli(tmp_path):

    market = make_market(
        buyer_count=210,
        seller_count=25,
    )

    input_path = tmp_path / "large-input.json"
    output_path = tmp_path / "large-output.json"

    input_path.write_text(
        market.model_dump_json(
            by_alias=True,
            indent=2,
        ),
        encoding="utf-8",
    )

    original_bytes = input_path.read_bytes()

    process = subprocess.run(
        [
            sys.executable,
            "-m",
            "matching_engine.cli",
            "--input", str(input_path),
            "--config", str(CONFIG_FIXTURE),
            "--output", str(output_path),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )

    assert process.returncode == 0, (
        process.stderr
    )

    assert process.stdout == ""
    assert output_path.is_file()

    output = MatchingOutput.model_validate_json(
        output_path.read_text(
            encoding="utf-8"
        )
    )

    assert len(output.matches) == 210
    assert output.unmatched_buyer_ids == []

    assert output.snapshot_id == market.snapshot_id

    assert input_path.read_bytes() == original_bytes

    # The backend will need to parse this exact format.
    assert output.execution_time_ms >= 0
