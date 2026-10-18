
"""
Tests for converting greedy allocations into MatchingOutput.

Includes:
- Shared Pydantic and JSON Schema validation
- Payment calculations
- Deterministic match IDs
- UTC timestamps
- Markets without matches
- Multiple matches and inventory conservation
- Rejection of inconsistent allocation plans
"""

import json

from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import pytest

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

from p2p_energy_shared import (
    HourlyEnergyRecord,
    MatchResult,
    MatchingInput,
    MatchingOutput,
    MarketRole,
)

from matching_engine.greedy import match_greedily

from matching_engine.output_builder import (
    build_matching_output,
    calculate_total_amount_microusd,
)


# --------------------------------------------------
# 1. Shared fixtures
# --------------------------------------------------

ROOT = Path(__file__).resolve().parents[3]

FIXTURES = ROOT / "packages" / "shared" / "fixtures"
SCHEMAS = ROOT / "packages" / "shared" / "schemas"

FIXED_TIME = datetime(
    2026, 10, 18, 15, 0, 0,
    tzinfo=timezone.utc,
)


def read_json(path):
    return json.loads(
        path.read_text(encoding="utf-8")
    )


@pytest.fixture
def matching_input():
    return MatchingInput.model_validate(
        read_json(
            FIXTURES / "matching-input.sample.json"
        )
    )


@pytest.fixture
def plan(matching_input):
    return match_greedily(matching_input)


def build(matching_input, plan, **options):
    return build_matching_output(
        matching_input,
        plan,
        created_at=FIXED_TIME,
        **options,
    )


def make_input_with_users(original, users):
    raw = original.model_dump(
        mode="json",
        by_alias=True,
    )

    raw["users"] = [
        user.model_dump(
            mode="json",
            by_alias=True,
        )
        for user in users
    ]

    return MatchingInput.model_validate(raw)


def make_two_buyer_input(original):
    """
    One seller with 8000 Wh and two buyers
    needing 4000 Wh and 3000 Wh respectively.
    """

    buyer = next(
        user for user in original.users
        if user.market_role == MarketRole.BUYER
    )

    seller = next(
        user for user in original.users
        if user.market_role == MarketRole.SELLER
    )

    seller_data = seller.model_dump(
        mode="json",
        by_alias=True,
    )

    seller_data["productionWh"] += 4000
    seller_data["netEnergyWh"] += 4000
    seller_data["availableEnergyWh"] += 4000

    larger_seller = HourlyEnergyRecord.model_validate(
        seller_data
    )

    buyer_data = buyer.model_dump(
        mode="json",
        by_alias=True,
    )

    buyer_data.update({
        "recordId": "33333333-3333-4333-8333-333333333334",
        "userId": "33333333-3333-4333-8333-333333333333",
        "evmAddress": "0x" + "3" * 40,
        "productionWh": 0,
        "consumptionWh": 3000,
        "netEnergyWh": -3000,
        "availableEnergyWh": 0,
        "requiredEnergyWh": 3000,
        "preferredEnergyType": "ANY",
    })

    second_buyer = HourlyEnergyRecord.model_validate(
        buyer_data
    )

    return make_input_with_users(
        original,
        [second_buyer, larger_seller, buyer],
    )


# ==================================================
# TEST 1 — Complete MatchResult structure
# ==================================================

def test_builds_complete_match_result(
    matching_input, plan
):

    output = build(matching_input, plan)

    assert isinstance(output, MatchingOutput)
    assert len(output.matches) == 1

    match = output.matches[0]

    assert isinstance(match, MatchResult)

    assert match.buyer_id == plan.matches[0].buyer_id
    assert match.seller_id == plan.matches[0].seller_id

    assert match.quantity_wh == 4000
    assert match.unit_price_microusd_per_kwh == 140000

    assert match.buyer_wallet.startswith("0x")
    assert match.seller_wallet.startswith("0x")

    assert match.seller_energy_type.value == "SOLAR"
    assert match.score == pytest.approx(
        plan.matches[0].score
    )

    assert output.unmatched_buyer_ids == []


# ==================================================
# TEST 2 — Correct energy payment calculation
# ==================================================

def test_total_payment_calculation(matching_input, plan):

    output = build(matching_input, plan)

    match = output.matches[0]

    assert match.total_amount_microusd == 560000

    assert calculate_total_amount_microusd(
        4000, 140000
    ) == 560000

    # Fractional micro-USD is rounded down.
    assert calculate_total_amount_microusd(
        4001, 140001
    ) == (4001 * 140001) // 1000


# ==================================================
# TEST 3 — Created timestamp is UTC
# ==================================================


def test_utc_creation_timestamp(matching_input, plan):

    output = build(matching_input, plan)

    match = output.matches[0]

    # MatchResult stores createdAt as a UTC string.
    assert isinstance(match.created_at, str)
    assert match.created_at.endswith("Z")

    # Parse the string back into a datetime.
    parsed_timestamp = datetime.fromisoformat(
        match.created_at.replace("Z", "+00:00")
    )

    assert parsed_timestamp == FIXED_TIME

    assert (
        parsed_timestamp.utcoffset().total_seconds()
        == 0
    )

# ==================================================
# TEST 4 — Match IDs are deterministic
# ==================================================

def test_match_ids_are_deterministic(matching_input, plan):

    first = build(matching_input, plan)
    second = build(matching_input, plan)

    assert first.matches[0].match_id == (
        second.matches[0].match_id
    )

    assert first == second


# ==================================================
# TEST 5 — CreatedAt does not affect match identity
# ==================================================

def test_created_time_does_not_change_match_id(
    matching_input, plan
):

    first = build(matching_input, plan)

    second = build_matching_output(
        matching_input,
        plan,
        created_at=datetime(
            2026, 10, 18, 16, 0,
            tzinfo=timezone.utc,
        ),
    )

    assert first.matches[0].match_id == (
        second.matches[0].match_id
    )

    assert first.matches[0].created_at != (
        second.matches[0].created_at
    )


# ==================================================
# TEST 6 — Different snapshot produces different ID
# ==================================================

def test_snapshot_id_affects_match_id(
    matching_input, plan
):

    changed_input = matching_input.model_copy(
        update={"snapshot_id": uuid4()}
    )

    first = build(matching_input, plan)
    second = build(changed_input, plan)

    assert first.matches[0].match_id != (
        second.matches[0].match_id
    )


# ==================================================
# TEST 7 — JSON round-trip preserves the result
# ==================================================

def test_output_json_round_trip(matching_input, plan):

    output = build(matching_input, plan)

    encoded = output.model_dump_json(
        by_alias=True,
        indent=2,
    )

    decoded = MatchingOutput.model_validate_json(
        encoded
    )

    assert decoded == output


# ==================================================
# TEST 8 — Output follows shared JSON Schema
# ==================================================

def test_output_matches_json_schema(matching_input, plan):

    output = build(matching_input, plan)

    data = output.model_dump(
        mode="json",
        by_alias=True,
    )

    schema_registry = Registry()

    for path in sorted(SCHEMAS.glob("*.schema.json")):

        schema = read_json(path)

        schema_registry = schema_registry.with_resource(
            schema["$id"],
            Resource.from_contents(schema),
        )

    schema = read_json(
        SCHEMAS / "matching-output.schema.json"
    )

    validator = Draft202012Validator(
        schema,
        registry=schema_registry,
        format_checker=FormatChecker(),
    )

    validator.validate(data)


# ==================================================
# TEST 9 — A market without sellers is valid
# ==================================================

def test_output_without_sellers(matching_input):

    buyer = next(
        user for user in matching_input.users
        if user.market_role == MarketRole.BUYER
    )

    market = make_input_with_users(
        matching_input, [buyer]
    )

    plan = match_greedily(market)
    output = build(market, plan)

    assert output.matches == []

    assert output.unmatched_buyer_ids == [
        buyer.user_id
    ]


# ==================================================
# TEST 10 — A market without buyers is valid
# ==================================================

def test_output_without_buyers(matching_input):

    seller = next(
        user for user in matching_input.users
        if user.market_role == MarketRole.SELLER
    )

    market = make_input_with_users(
        matching_input, [seller]
    )

    plan = match_greedily(market)
    output = build(market, plan)

    assert output.matches == []
    assert output.unmatched_buyer_ids == []


# ==================================================
# TEST 11 — Multiple matches preserve inventory
# ==================================================

def test_one_seller_can_serve_two_buyers(matching_input):

    market = make_two_buyer_input(matching_input)

    plan = match_greedily(market)
    output = build(market, plan)

    assert len(output.matches) == 2

    quantities = [
        match.quantity_wh
        for match in output.matches
    ]

    assert quantities == [4000, 3000]

    assert sum(quantities) == 7000

    assert len({
        match.buyer_id for match in output.matches
    }) == 2

    assert output.unmatched_buyer_ids == []


# ==================================================
# TEST 12 — Do not modify input objects
# ==================================================

def test_output_builder_does_not_mutate_inputs(
    matching_input, plan
):

    original_input = matching_input.model_dump(
        mode="json",
        by_alias=True,
    )

    original_plan = tuple(plan.matches)
    original_remaining = dict(plan.remaining_by_seller_wh)

    build(matching_input, plan)

    assert matching_input.model_dump(
        mode="json",
        by_alias=True,
    ) == original_input

    assert plan.matches == original_plan
    assert dict(plan.remaining_by_seller_wh) == original_remaining


# ==================================================
# TEST 13 — Reject incorrect object types
# ==================================================

@pytest.mark.parametrize(
    "invalid_argument",
    ["matching_input", "plan"],
)
def test_rejects_wrong_object_types(
    matching_input, plan, invalid_argument
):

    if invalid_argument == "matching_input":
        matching_input = {}
    else:
        plan = {}

    with pytest.raises(TypeError):
        build(matching_input, plan)


# ==================================================
# TEST 14 — Reject invalid execution times
# ==================================================

@pytest.mark.parametrize(
    "invalid_time",
    [-1, 1.5, True],
)
def test_rejects_invalid_execution_time(
    matching_input, plan, invalid_time
):

    with pytest.raises((TypeError, ValueError)):
        build(
            matching_input,
            plan,
            execution_time_ms=invalid_time,
        )


# ==================================================
# TEST 15 — Reject invalid createdAt values
# ==================================================

@pytest.mark.parametrize(
    "invalid_timestamp",
    [
        datetime(2026, 10, 18, 15, 0),
        "2026-10-18T15:00:00Z",
    ],
)
def test_rejects_invalid_created_at(
    matching_input, plan, invalid_timestamp
):

    with pytest.raises((TypeError, ValueError)):
        build_matching_output(
            matching_input,
            plan,
            created_at=invalid_timestamp,
        )


# ==================================================
# TEST 16 — Reject invalid payment arguments
# ==================================================

@pytest.mark.parametrize(
    "quantity,price",
    [
        (0, 140000),
        (4000, 0),
        (True, 140000),
        (4000, "140000"),
    ],
)
def test_rejects_invalid_payment_inputs(
    quantity, price
):

    with pytest.raises((TypeError, ValueError)):
        calculate_total_amount_microusd(
            quantity, price
        )


# ==================================================
# TEST 17 — Reject an overallocated plan
# ==================================================

def test_rejects_overallocated_plan(
    matching_input, plan
):

    original = plan.matches[0]

    forged_match = replace(
        original,
        quantity_wh=original.quantity_wh + 1,
    )

    forged_plan = replace(
        plan,
        matches=(forged_match,),
    )

    with pytest.raises(
        ValueError,
        match="fully satisfy",
    ):
        build(matching_input, forged_plan)


# ==================================================
# TEST 18 — Reject inconsistent unmatched buyers
# ==================================================

def test_rejects_wrong_unmatched_buyers(
    matching_input, plan
):

    buyer_id = plan.matches[0].buyer_id

    forged_plan = replace(
        plan,
        unmatched_buyer_ids=(buyer_id,),
    )

    with pytest.raises(
        ValueError,
        match="Unmatched buyer IDs are inconsistent",
    ):
        build(matching_input, forged_plan)


# ==================================================
# TEST 19 — Reject incorrect remaining inventory
# ==================================================

def test_rejects_wrong_remaining_inventory(
    matching_input, plan
):

    seller_id = plan.matches[0].seller_id

    forged_plan = replace(
        plan,
        remaining_by_seller_wh={
            seller_id: 1000,
        },
    )

    with pytest.raises(
        ValueError,
        match="Seller remaining inventory",
    ):
        build(matching_input, forged_plan)


# ==================================================
# TEST 20 — Default timestamp uses current UTC
# ==================================================


def test_default_timestamp_is_current_utc(
    matching_input, plan
):

    before = datetime.now(timezone.utc)

    output = build_matching_output(
        matching_input,
        plan,
    )

    after = datetime.now(timezone.utc)

    created_at_string = output.matches[0].created_at

    # Verify the shared model uses a UTC string.
    assert isinstance(created_at_string, str)
    assert created_at_string.endswith("Z")

    # Convert it back into a timezone-aware datetime.
    created = datetime.fromisoformat(
        created_at_string.replace("Z", "+00:00")
    )

    assert before <= created <= after

    assert created.utcoffset().total_seconds() == 0
