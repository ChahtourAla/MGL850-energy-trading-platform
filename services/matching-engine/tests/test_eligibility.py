
"""
Tests for buyer-seller eligibility.

Tests use the existing MatchingInput fixture
created in Step 2.
"""

import math
import json

from pathlib import Path

import pytest

from p2p_energy_shared import (
    HourlyEnergyRecord,
    MarketRole,
    MatchingInput,
)

from matching_engine.eligibility import (
    calculate_distance_km,
    check_pair_eligibility,
    find_eligible_sellers,
)


# --------------------------------------------------
# 1. Load existing matching input
# --------------------------------------------------

ROOT = Path(__file__).resolve().parents[3]

INPUT_PATH = (
    ROOT
    / "packages"
    / "shared"
    / "fixtures"
    / "matching-input.sample.json"
)


@pytest.fixture
def matching_input():

    return MatchingInput.model_validate_json(
        INPUT_PATH.read_text(encoding="utf-8")
    )


@pytest.fixture
def pair(matching_input):

    buyer = next(
        record for record in matching_input.users
        if record.market_role == MarketRole.BUYER
    )

    seller = next(
        record for record in matching_input.users
        if record.market_role == MarketRole.SELLER
    )

    return buyer, seller


def changed_record(record, **changes):
    """
    Modify a copy of a fixture record and
    revalidate it with the shared model.
    """

    data = record.model_dump(
        mode="json",
        by_alias=True,
    )

    data.update(changes)

    return HourlyEnergyRecord.model_validate(data)


# --------------------------------------------------
# TEST 1 — Valid pair is eligible
# --------------------------------------------------

def test_valid_buyer_seller_pair(
    matching_input,
    pair,
):

    buyer, seller = pair

    result = check_pair_eligibility(
        buyer,
        seller,
        matching_input.maximum_distance_km,
    )

    assert result.eligible is True
    assert result.reason is None
    assert result.distance_km is not None


# --------------------------------------------------
# TEST 2 — Exact quantity and price limits pass
# --------------------------------------------------

def test_exact_quantity_and_price_boundary(
    matching_input,
    pair,
):

    buyer, seller = pair

    assert (
        seller.available_energy_wh
        == buyer.required_energy_wh
    )

    buyer = changed_record(
        buyer,
        maxPriceMicrousdPerKwh=(
            seller.ask_price_microusd_per_kwh
        ),
    )

    result = check_pair_eligibility(
        buyer,
        seller,
        matching_input.maximum_distance_km,
    )

    assert result.eligible is True


# --------------------------------------------------
# TEST 3 — Euclidean distance is correct
# --------------------------------------------------

def test_calculates_euclidean_distance(pair):

    buyer, seller = pair

    expected = math.hypot(
        buyer.x_km - seller.x_km,
        buyer.y_km - seller.y_km,
    )

    actual = calculate_distance_km(
        buyer,
        seller,
    )

    assert actual == pytest.approx(expected)


# --------------------------------------------------
# TEST 4 — Exact distance boundary is eligible
# --------------------------------------------------

def test_exact_distance_boundary(pair):

    buyer, seller = pair

    exact_limit = calculate_distance_km(
        buyer,
        seller,
    )

    result = check_pair_eligibility(
        buyer,
        seller,
        exact_limit,
    )

    assert result.eligible is True


# --------------------------------------------------
# TEST 5 — Both roles must be correct
# --------------------------------------------------

@pytest.mark.parametrize(
    "case,expected_reason",
    [
        ("wrong-buyer", "BUYER_ROLE_REQUIRED"),
        ("wrong-seller", "SELLER_ROLE_REQUIRED"),
    ],
)
def test_requires_correct_market_roles(
    pair,
    case,
    expected_reason,
):

    buyer, seller = pair

    if case == "wrong-buyer":
        first = seller
        second = seller
    else:
        first = buyer
        second = buyer

    result = check_pair_eligibility(
        first,
        second,
        10.0,
    )

    assert not result.eligible
    assert result.reason == expected_reason


# --------------------------------------------------
# TEST 6 — Reject trading with the same user
# --------------------------------------------------

def test_rejects_self_trade(pair):

    buyer, seller = pair

    seller = changed_record(
        seller,
        userId=str(buyer.user_id),
    )

    result = check_pair_eligibility(
        buyer,
        seller,
        10.0,
    )

    assert not result.eligible
    assert result.reason == "SAME_USER"


# --------------------------------------------------
# TEST 7 — Reject two users sharing a wallet
# --------------------------------------------------

def test_rejects_same_wallet(pair):

    buyer, seller = pair

    seller = changed_record(
        seller,
        evmAddress=buyer.evm_address,
    )

    result = check_pair_eligibility(
        buyer,
        seller,
        10.0,
    )

    assert not result.eligible
    assert result.reason == "SAME_WALLET"


# --------------------------------------------------
# TEST 8 — Reject different time slots
# --------------------------------------------------

def test_rejects_different_hours(pair):

    buyer, seller = pair

    seller = changed_record(
        seller,
        timeSlot="2026-11-01T12:00:00Z",
    )

    result = check_pair_eligibility(
        buyer,
        seller,
        10.0,
    )

    assert not result.eligible
    assert result.reason == "TIME_SLOT_MISMATCH"


# --------------------------------------------------
# TEST 9 — Reject insufficient seller energy
# --------------------------------------------------

def test_rejects_insufficient_seller_energy(pair):

    buyer, seller = pair

    smaller_supply = buyer.required_energy_wh - 1

    seller = changed_record(
        seller,
        productionWh=(
            seller.consumption_wh + smaller_supply
        ),
        netEnergyWh=smaller_supply,
        availableEnergyWh=smaller_supply,
    )

    result = check_pair_eligibility(
        buyer,
        seller,
        10.0,
    )

    assert not result.eligible
    assert result.reason == "INSUFFICIENT_ENERGY"


# --------------------------------------------------
# TEST 10 — Check updated seller inventory
# --------------------------------------------------

@pytest.mark.parametrize(
    "fraction,expected",
    [
        (0.0, False),
        (0.5, False),
        (1.0, True),
    ],
)
def test_checks_remaining_seller_energy(
    pair,
    fraction,
    expected,
):

    buyer, seller = pair

    remaining = int(
        buyer.required_energy_wh * fraction
    )

    result = check_pair_eligibility(
        buyer,
        seller,
        10.0,
        remaining_seller_wh=remaining,
    )

    assert result.eligible is expected

    if not expected:
        assert result.reason == "INSUFFICIENT_ENERGY"


# --------------------------------------------------
# TEST 11 — Reject unaffordable electricity
# --------------------------------------------------

def test_rejects_seller_price_above_buyer_limit(pair):

    buyer, seller = pair

    buyer = changed_record(
        buyer,
        maxPriceMicrousdPerKwh=(
            seller.ask_price_microusd_per_kwh - 1
        ),
    )

    result = check_pair_eligibility(
        buyer,
        seller,
        10.0,
    )

    assert not result.eligible
    assert result.reason == "PRICE_TOO_HIGH"


# --------------------------------------------------
# TEST 12 — Reject incompatible energy source
# --------------------------------------------------

def test_rejects_energy_type_mismatch(pair):

    buyer, seller = pair

    buyer = changed_record(
        buyer,
        preferredEnergyType="WIND",
    )

    result = check_pair_eligibility(
        buyer,
        seller,
        10.0,
    )

    assert not result.eligible
    assert result.reason == "ENERGY_TYPE_MISMATCH"


# --------------------------------------------------
# TEST 13 — ANY accepts the seller's source
# --------------------------------------------------

def test_any_energy_preference(pair):

    buyer, seller = pair

    buyer = changed_record(
        buyer,
        preferredEnergyType="ANY",
    )

    result = check_pair_eligibility(
        buyer,
        seller,
        10.0,
    )

    assert result.eligible is True


# --------------------------------------------------
# TEST 14 — Matching the exact source is accepted
# --------------------------------------------------

def test_exact_energy_source_preference(pair):

    buyer, seller = pair

    buyer = changed_record(
        buyer,
        preferredEnergyType=seller.energy_type.value,
    )

    result = check_pair_eligibility(
        buyer,
        seller,
        10.0,
    )

    assert result.eligible is True


# --------------------------------------------------
# TEST 15 — Reject a seller beyond max distance
# --------------------------------------------------

def test_rejects_excessive_distance(pair):

    buyer, seller = pair

    distance = calculate_distance_km(
        buyer,
        seller,
    )

    result = check_pair_eligibility(
        buyer,
        seller,
        maximum_distance_km=distance / 2,
    )

    assert not result.eligible
    assert result.reason == "DISTANCE_EXCEEDED"
    assert result.distance_km == pytest.approx(distance)


# --------------------------------------------------
# TEST 16 — Reject invalid distance configuration
# --------------------------------------------------

@pytest.mark.parametrize(
    "invalid_limit",
    [
        0,
        -1,
        float("inf"),
        float("nan"),
    ],
)
def test_rejects_invalid_distance_limit(
    pair,
    invalid_limit,
):

    buyer, seller = pair

    with pytest.raises(ValueError):
        check_pair_eligibility(
            buyer,
            seller,
            invalid_limit,
        )


# --------------------------------------------------
# TEST 17 — Reject invalid inventory values
# --------------------------------------------------

@pytest.mark.parametrize(
    "case",
    [
        "negative",
        "excess",
        "string",
        "boolean",
    ],
)
def test_rejects_invalid_remaining_inventory(
    pair,
    case,
):

    buyer, seller = pair

    values = {
        "negative": -1,
        "excess": seller.available_energy_wh + 1,
        "string": "1000",
        "boolean": True,
    }

    with pytest.raises((TypeError, ValueError)):
        check_pair_eligibility(
            buyer,
            seller,
            10.0,
            remaining_seller_wh=values[case],
        )


# --------------------------------------------------
# TEST 18 — Reject incorrect record objects
# --------------------------------------------------

@pytest.mark.parametrize(
    "invalid_argument",
    ["buyer", "seller"],
)
def test_rejects_wrong_record_types(
    pair,
    invalid_argument,
):

    buyer, seller = pair

    if invalid_argument == "buyer":
        buyer = {}
    else:
        seller = {}

    with pytest.raises(TypeError):
        check_pair_eligibility(
            buyer,
            seller,
            10.0,
        )


# --------------------------------------------------
# TEST 19 — Find eligible sellers in MatchingInput
# --------------------------------------------------

def test_finds_eligible_sellers(
    matching_input,
    pair,
):

    buyer, seller = pair

    candidates = find_eligible_sellers(
        matching_input,
        buyer,
    )

    assert len(candidates) == 1

    assert (
        candidates[0].seller.user_id
        == seller.user_id
    )

    assert candidates[0].distance_km == pytest.approx(
        calculate_distance_km(buyer, seller)
    )


# --------------------------------------------------
# TEST 20 — Respect updated inventory in search
# --------------------------------------------------

def test_search_uses_remaining_inventory(
    matching_input,
    pair,
):

    buyer, seller = pair

    candidates = find_eligible_sellers(
        matching_input,
        buyer,
        remaining_by_seller={
            seller.user_id: 0
        },
    )

    assert candidates == []


# --------------------------------------------------
# TEST 21 — Candidate order is deterministic
# --------------------------------------------------

def test_candidate_order_is_deterministic(
    matching_input,
    pair,
):

    buyer, seller = pair

    # Add a second eligible seller with a lower UUID.
    raw = matching_input.model_dump(
        mode="json",
        by_alias=True,
    )

    other_seller = seller.model_dump(
        mode="json",
        by_alias=True,
    )

    other_seller["userId"] = (
        "00000000-0000-4000-8000-000000000001"
    )

    other_seller["recordId"] = (
        "00000000-0000-4000-8000-000000000002"
    )

    other_seller["evmAddress"] = "0x" + "3" * 40

    raw["users"].append(other_seller)

    expanded_input = MatchingInput.model_validate(raw)

    candidates = find_eligible_sellers(
        expanded_input,
        buyer,
    )

    assert len(candidates) == 2

    ids = [
        str(candidate.seller.user_id)
        for candidate in candidates
    ]

    assert ids == sorted(ids)


# --------------------------------------------------
# TEST 22 — Buyer must belong to MatchingInput
# --------------------------------------------------

def test_rejects_buyer_outside_matching_input(
    matching_input,
    pair,
):

    buyer, _ = pair

    outsider = changed_record(
        buyer,
        userId="99999999-9999-4999-8999-999999999999",
    )

    with pytest.raises(
        ValueError,
        match="Buyer not found",
    ):
        find_eligible_sellers(
            matching_input,
            outsider,
        )
