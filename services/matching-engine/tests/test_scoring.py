
"""
Tests for weighted matching scores and seller ranking.
"""

import math
from dataclasses import replace
from pathlib import Path

import pytest

from p2p_energy_shared import (
    HourlyEnergyRecord,
    MarketRole,
    MatchingInput,
)

from matching_engine.eligibility import (
    calculate_distance_km,
)

from matching_engine.scoring import (
    ScoredSeller,
    calculate_pair_score,
    rank_eligible_sellers,
    sort_scored_sellers,
)


# --------------------------------------------------
# 1. Load our existing MatchingInput fixture
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
        user for user in matching_input.users
        if user.market_role == MarketRole.BUYER
    )

    seller = next(
        user for user in matching_input.users
        if user.market_role == MarketRole.SELLER
    )

    return buyer, seller


# --------------------------------------------------
# 2. Helpers for valid modified records
# --------------------------------------------------

def changed_record(record, **changes):

    data = record.model_dump(
        mode="json",
        by_alias=True,
    )

    data.update(changes)

    return HourlyEnergyRecord.model_validate(data)


def extra_seller(seller, **changes):

    data = seller.model_dump(
        mode="json",
        by_alias=True,
    )

    data.update({
        "userId": "00000000-0000-4000-8000-000000000001",
        "recordId": "00000000-0000-4000-8000-000000000002",
        "evmAddress": "0x" + "3" * 40,
    })

    data.update(changes)

    return HourlyEnergyRecord.model_validate(data)


def with_second_seller(matching_input, seller):

    data = matching_input.model_dump(
        mode="json",
        by_alias=True,
    )

    data["users"].append(
        seller.model_dump(
            mode="json",
            by_alias=True,
        )
    )

    return MatchingInput.model_validate(data)


# --------------------------------------------------
# TEST 1 — Calculate a valid pair score
# --------------------------------------------------

def test_calculates_valid_score(pair, matching_input):

    buyer, seller = pair

    scored = calculate_pair_score(
        buyer, seller, matching_input
    )

    assert isinstance(scored, ScoredSeller)
    assert scored.seller.user_id == seller.user_id
    assert 0 <= scored.score.final_score <= 1


# --------------------------------------------------
# TEST 2 — Formula matches the technical specification
# --------------------------------------------------

def test_scoring_formula(pair, matching_input):

    buyer, seller = pair

    result = calculate_pair_score(
        buyer, seller, matching_input
    )

    distance = calculate_distance_km(
        buyer, seller
    )

    expected_quantity = (
        buyer.required_energy_wh
        / seller.available_energy_wh
    )

    expected_price = 1 - (
        seller.ask_price_microusd_per_kwh
        / buyer.max_price_microusd_per_kwh
    )

    expected_distance = 1 - (
        distance
        / matching_input.maximum_distance_km
    )

    expected_reputation = seller.reputation / 100

    weights = matching_input.scoring_weights

    expected_final = (
        weights.quantity * expected_quantity
        + weights.price * expected_price
        + weights.distance * expected_distance
        + weights.reputation * expected_reputation
    )

    assert result.score.quantity_score == pytest.approx(
        expected_quantity
    )

    assert result.score.price_score == pytest.approx(
        expected_price
    )

    assert result.score.distance_score == pytest.approx(
        expected_distance
    )

    assert result.score.reputation_score == pytest.approx(
        expected_reputation
    )

    assert result.score.final_score == pytest.approx(
        expected_final
    )


# --------------------------------------------------
# TEST 3 — All scoring components are normalized
# --------------------------------------------------

def test_all_components_are_normalized(
    pair, matching_input
):

    buyer, seller = pair

    result = calculate_pair_score(
        buyer, seller, matching_input
    )

    values = [
        result.score.quantity_score,
        result.score.price_score,
        result.score.distance_score,
        result.score.reputation_score,
        result.score.final_score,
    ]

    assert all(
        math.isfinite(value)
        and 0 <= value <= 1
        for value in values
    )


# --------------------------------------------------
# TEST 4 — Scoring is reproducible
# --------------------------------------------------

def test_scoring_is_deterministic(pair, matching_input):

    buyer, seller = pair

    first = calculate_pair_score(
        buyer, seller, matching_input
    )

    second = calculate_pair_score(
        buyer, seller, matching_input
    )

    assert first == second


# --------------------------------------------------
# TEST 5 — Exact fulfillment gets quantity score 1
# --------------------------------------------------

def test_exact_fulfillment_score(pair, matching_input):

    buyer, seller = pair

    result = calculate_pair_score(
        buyer, seller, matching_input
    )

    assert result.score.quantity_score == 1.0


# --------------------------------------------------
# TEST 6 — Remaining energy changes quantity score
# --------------------------------------------------

def test_quantity_uses_remaining_inventory(
    pair, matching_input
):

    buyer, seller = pair

    # Increase seller's validated surplus to 8000 Wh.
    seller = changed_record(
        seller,
        productionWh=seller.production_wh + 4000,
        netEnergyWh=seller.net_energy_wh + 4000,
        availableEnergyWh=(
            seller.available_energy_wh + 4000
        ),
    )

    full_inventory = calculate_pair_score(
        buyer,
        seller,
        matching_input,
        remaining_seller_wh=8000,
    )

    reduced_inventory = calculate_pair_score(
        buyer,
        seller,
        matching_input,
        remaining_seller_wh=4000,
    )

    assert full_inventory.score.quantity_score == 0.5
    assert reduced_inventory.score.quantity_score == 1.0

    assert (
        reduced_inventory.score.final_score
        > full_inventory.score.final_score
    )


# --------------------------------------------------
# TEST 7 — Exact price boundary gets price score 0
# --------------------------------------------------

def test_price_boundary_score(pair, matching_input):

    buyer, seller = pair

    buyer = changed_record(
        buyer,
        maxPriceMicrousdPerKwh=(
            seller.ask_price_microusd_per_kwh
        ),
    )

    result = calculate_pair_score(
        buyer, seller, matching_input
    )

    assert result.score.price_score == 0.0


# --------------------------------------------------
# TEST 8 — Max distance gets distance score 0
# --------------------------------------------------

def test_distance_boundary_score(pair, matching_input):

    buyer, seller = pair

    limit = calculate_distance_km(
        buyer, seller
    )

    changed_input = matching_input.model_copy(
        update={
            "maximum_distance_km": limit
        }
    )

    result = calculate_pair_score(
        buyer, seller, changed_input
    )

    assert result.score.distance_score == 0.0


# --------------------------------------------------
# TEST 9 — Reputation normalization
# --------------------------------------------------

@pytest.mark.parametrize(
    "reputation,expected",
    [
        (0, 0.0),
        (100, 1.0),
    ],
)
def test_reputation_normalization(
    pair, matching_input,
    reputation, expected,
):

    buyer, seller = pair

    seller = changed_record(
        seller,
        reputation=reputation,
    )

    result = calculate_pair_score(
        buyer, seller, matching_input
    )

    assert result.score.reputation_score == expected


# --------------------------------------------------
# TEST 10 — Reject ineligible pairs
# --------------------------------------------------

@pytest.mark.parametrize(
    "case",
    ["price", "energy-type", "quantity"],
)
def test_rejects_ineligible_pair(
    pair, matching_input, case
):

    buyer, seller = pair
    remaining = None

    if case == "price":
        buyer = changed_record(
            buyer,
            maxPriceMicrousdPerKwh=(
                seller.ask_price_microusd_per_kwh - 1
            ),
        )

    elif case == "energy-type":
        buyer = changed_record(
            buyer,
            preferredEnergyType="WIND",
        )

    else:
        remaining = buyer.required_energy_wh - 1

    with pytest.raises(
        ValueError,
        match="not eligible",
    ):
        calculate_pair_score(
            buyer,
            seller,
            matching_input,
            remaining_seller_wh=remaining,
        )


# --------------------------------------------------
# TEST 11 — Reject invalid remaining inventories
# --------------------------------------------------

@pytest.mark.parametrize(
    "remaining",
    [-1, 0, 4001, True],
)
def test_rejects_invalid_or_insufficient_remaining(
    pair, matching_input, remaining
):

    buyer, seller = pair

    with pytest.raises((TypeError, ValueError)):
        calculate_pair_score(
            buyer,
            seller,
            matching_input,
            remaining_seller_wh=remaining,
        )


# --------------------------------------------------
# TEST 12 — Reject wrong input types
# --------------------------------------------------

@pytest.mark.parametrize(
    "case",
    ["buyer", "seller", "matching-input"],
)
def test_rejects_wrong_input_types(
    pair, matching_input, case
):

    buyer, seller = pair

    if case == "buyer":
        buyer = {}

    elif case == "seller":
        seller = {}

    else:
        matching_input = {}

    with pytest.raises(TypeError):
        calculate_pair_score(
            buyer,
            seller,
            matching_input,
        )


# --------------------------------------------------
# TEST 13 — Rank one eligible seller
# --------------------------------------------------

def test_ranks_single_seller(pair, matching_input):

    buyer, seller = pair

    results = rank_eligible_sellers(
        matching_input, buyer
    )

    assert len(results) == 1
    assert results[0].seller.user_id == seller.user_id


# --------------------------------------------------
# TEST 14 — Prefer a cheaper otherwise equal seller
# --------------------------------------------------

def test_ranking_prefers_lower_price(
    pair, matching_input
):

    buyer, seller = pair

    cheaper = extra_seller(
        seller,
        askPriceMicrousdPerKwh=100000,
    )

    expanded = with_second_seller(
        matching_input, cheaper
    )

    results = rank_eligible_sellers(
        expanded, buyer
    )

    assert len(results) == 2
    assert results[0].seller.user_id == cheaper.user_id

    assert (
        results[0].score.final_score
        > results[1].score.final_score
    )


# --------------------------------------------------
# TEST 15 — Prefer a closer otherwise equal seller
# --------------------------------------------------

def test_ranking_prefers_shorter_distance(
    pair, matching_input
):

    buyer, seller = pair

    closer = extra_seller(
        seller,
        xKm=buyer.x_km,
        yKm=buyer.y_km,
    )

    expanded = with_second_seller(
        matching_input, closer
    )

    results = rank_eligible_sellers(
        expanded, buyer
    )

    assert len(results) == 2
    assert results[0].seller.user_id == closer.user_id
    assert results[0].distance_km == 0


# --------------------------------------------------
# TEST 16 — Prefer higher seller reputation
# --------------------------------------------------

def test_ranking_prefers_reputation(
    pair, matching_input
):

    buyer, seller = pair

    better = extra_seller(
        seller,
        reputation=100,
    )

    expanded = with_second_seller(
        matching_input, better
    )

    results = rank_eligible_sellers(
        expanded, buyer
    )

    assert len(results) == 2
    assert results[0].seller.user_id == better.user_id


# --------------------------------------------------
# TEST 17 — Resolve exactly equal scores by UUID
# --------------------------------------------------

def test_equal_scores_use_lexical_seller_id(
    pair, matching_input
):

    buyer, seller = pair

    duplicate_terms = extra_seller(seller)

    expanded = with_second_seller(
        matching_input, duplicate_terms
    )

    results = rank_eligible_sellers(
        expanded, buyer
    )

    assert len(results) == 2

    assert (
        results[0].score.final_score
        == results[1].score.final_score
    )

    ids = [
        str(item.seller.user_id)
        for item in results
    ]

    assert ids == sorted(ids)


# --------------------------------------------------
# TEST 18 — Tie-break by lower price
# --------------------------------------------------

def test_equal_scores_tie_break_by_price(
    pair, matching_input
):

    buyer, seller = pair

    baseline = calculate_pair_score(
        buyer, seller, matching_input
    )

    cheaper = extra_seller(
        seller,
        askPriceMicrousdPerKwh=100000,
    )

    # Artificial equal scores let us isolate and
    # test only the tie-break behavior.
    other = ScoredSeller(
        seller=cheaper,
        distance_km=baseline.distance_km,
        score=baseline.score,
    )

    ranked = sort_scored_sellers([
        baseline, other
    ])

    assert ranked[0].seller.user_id == cheaper.user_id


# --------------------------------------------------
# TEST 19 — Tie-break by shorter distance
# --------------------------------------------------

def test_equal_scores_tie_break_by_distance(
    pair, matching_input
):

    buyer, seller = pair

    baseline = calculate_pair_score(
        buyer, seller, matching_input
    )

    closer = extra_seller(
        seller,
        xKm=buyer.x_km,
        yKm=buyer.y_km,
    )

    other = ScoredSeller(
        seller=closer,
        distance_km=0.0,
        score=baseline.score,
    )

    ranked = sort_scored_sellers([
        baseline, other
    ])

    assert ranked[0].seller.user_id == closer.user_id


# --------------------------------------------------
# TEST 20 — Updated inventory removes a seller
# --------------------------------------------------

def test_ranking_respects_remaining_inventory(
    pair, matching_input
):

    buyer, seller = pair

    results = rank_eligible_sellers(
        matching_input,
        buyer,
        remaining_by_seller={
            seller.user_id: 0,
        },
    )

    assert results == []


# --------------------------------------------------
# TEST 21 — Outsider buyers cannot request rankings
# --------------------------------------------------

def test_rejects_outside_buyer(
    pair, matching_input
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
        rank_eligible_sellers(
            matching_input,
            outsider,
        )


# --------------------------------------------------
# TEST 22 — Ranking requires a valid inventory map
# --------------------------------------------------

def test_ranking_rejects_invalid_inventory_map(
    pair, matching_input
):

    buyer, _ = pair

    with pytest.raises(TypeError):
        rank_eligible_sellers(
            matching_input,
            buyer,
            remaining_by_seller=[],
        )


# --------------------------------------------------
# TEST 23 — Scoring never modifies input records
# --------------------------------------------------

def test_scoring_does_not_mutate_inputs(
    pair, matching_input
):

    buyer, seller = pair

    before_buyer = buyer.model_dump()
    before_seller = seller.model_dump()
    before_input = matching_input.model_dump()

    calculate_pair_score(
        buyer, seller, matching_input
    )

    rank_eligible_sellers(
        matching_input, buyer
    )

    assert buyer.model_dump() == before_buyer
    assert seller.model_dump() == before_seller
    assert matching_input.model_dump() == before_input
