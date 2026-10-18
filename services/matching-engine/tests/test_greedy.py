
"""
Tests for deterministic greedy energy matching.

These tests verify allocation order, inventory
tracking, full-buyer fulfillment, seller selection,
unmatched buyers, and reproducibility.
"""

from pathlib import Path

import pytest

from p2p_energy_shared import (
    HourlyEnergyRecord,
    MarketRole,
    MatchingInput,
)

from matching_engine.greedy import (
    GreedyMatchingPlan,
    match_greedily,
)

from matching_engine.scoring import (
    rank_eligible_sellers,
)


# --------------------------------------------------
# 1. Existing shared fixture
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


# --------------------------------------------------
# 2. Helpers for constructing valid test scenarios
# --------------------------------------------------

def changed_record(record, **changes):

    raw = record.model_dump(
        mode="json",
        by_alias=True,
    )

    raw.update(changes)

    return HourlyEnergyRecord.model_validate(raw)


def make_buyer(
    original_buyer,
    number: int,
    demand_wh: int,
):
    """
    Add a buyer with a distinct UUID and wallet.

    Supported test identities: 3 and 4.
    """

    if number not in (3, 4):
        raise ValueError("Unsupported test buyer identity")

    digit = str(number)

    user_id = (
        f"{digit * 8}-{digit * 4}-"
        f"4{digit * 3}-8{digit * 3}-"
        f"{digit * 12}"
    )

    record_id = (
        f"{digit * 8}-{digit * 4}-"
        f"4{digit * 3}-8{digit * 3}-"
        f"{digit * 11}0"
    )

    return changed_record(
        original_buyer,
        userId=user_id,
        recordId=record_id,
        evmAddress=f"0x{number:040x}",
        productionWh=0,
        consumptionWh=demand_wh,
        netEnergyWh=-demand_wh,
        availableEnergyWh=0,
        requiredEnergyWh=demand_wh,
        preferredEnergyType="ANY",
    )


def make_seller(
    original_seller,
    supply_wh: int,
    clone: bool = False,
    asking_price: int | None = None,
):
    """
    Create a seller with the requested surplus.
    """

    changes = {
        "productionWh": (
            original_seller.consumption_wh + supply_wh
        ),
        "netEnergyWh": supply_wh,
        "availableEnergyWh": supply_wh,
    }

    if clone:
        changes.update({
            "userId": (
                "55555555-5555-4555-8555-555555555555"
            ),
            "recordId": (
                "55555555-5555-4555-8555-555555555556"
            ),
            "evmAddress": "0x" + "5" * 40,
        })

    if asking_price is not None:
        changes["askPriceMicrousdPerKwh"] = (
            asking_price
        )

    return changed_record(
        original_seller,
        **changes,
    )


def make_input(original_input, *records):
    """
    Construct a fully validated MatchingInput
    containing the specified records.
    """

    raw = original_input.model_dump(
        mode="json",
        by_alias=True,
    )

    raw["users"] = [
        record.model_dump(
            mode="json",
            by_alias=True,
        )
        for record in records
    ]

    return MatchingInput.model_validate(raw)


# ==================================================
# TEST 1 — Match one buyer and one seller
# ==================================================

def test_matches_single_buyer_and_seller(
    matching_input,
    pair,
):

    buyer, seller = pair

    plan = match_greedily(matching_input)

    assert isinstance(plan, GreedyMatchingPlan)
    assert len(plan.matches) == 1
    assert plan.unmatched_buyer_ids == ()

    match = plan.matches[0]

    assert match.buyer_id == buyer.user_id
    assert match.seller_id == seller.user_id
    assert match.quantity_wh == 4000
    assert (
        match.unit_price_microusd_per_kwh
        == seller.ask_price_microusd_per_kwh
    )


# ==================================================
# TEST 2 — Preserve the computed matching score
# ==================================================

def test_allocations_use_ranked_score(
    matching_input,
    pair,
):

    buyer, seller = pair

    ranked = rank_eligible_sellers(
        matching_input,
        buyer,
    )

    plan = match_greedily(matching_input)

    assert plan.matches[0].seller_id == seller.user_id

    assert plan.matches[0].score == pytest.approx(
        ranked[0].score.final_score
    )

    assert plan.matches[0].distance_km == pytest.approx(
        ranked[0].distance_km
    )


# ==================================================
# TEST 3 — Seller inventory decreases
# ==================================================

def test_deducts_seller_inventory(
    matching_input,
    pair,
):

    _, seller = pair

    plan = match_greedily(matching_input)

    assert (
        plan.remaining_by_seller_wh[seller.user_id]
        == 0
    )


# ==================================================
# TEST 4 — One seller can serve multiple buyers
# ==================================================

def test_seller_serves_multiple_buyers(
    matching_input,
    pair,
):

    buyer, seller = pair

    large_seller = make_seller(
        seller, supply_wh=8000
    )

    second_buyer = make_buyer(
        buyer, number=3, demand_wh=3000
    )

    expanded = make_input(
        matching_input,
        second_buyer,
        large_seller,
        buyer,
    )

    plan = match_greedily(expanded)

    assert len(plan.matches) == 2
    assert plan.unmatched_buyer_ids == ()

    assert [
        match.quantity_wh
        for match in plan.matches
    ] == [4000, 3000]

    assert (
        plan.remaining_by_seller_wh[
            large_seller.user_id
        ] == 1000
    )


# ==================================================
# TEST 5 — Largest buyer is processed first
# ==================================================

def test_prioritizes_largest_buyer(
    matching_input,
    pair,
):

    buyer, seller = pair

    seller = make_seller(
        seller, supply_wh=5000
    )

    smaller_buyer = make_buyer(
        buyer, number=3, demand_wh=3000
    )

    # Deliberately place the smaller buyer first.
    expanded = make_input(
        matching_input,
        smaller_buyer,
        seller,
        buyer,
    )

    plan = match_greedily(expanded)

    assert len(plan.matches) == 1

    assert plan.matches[0].buyer_id == buyer.user_id

    assert plan.unmatched_buyer_ids == (
        smaller_buyer.user_id,
    )

    assert (
        plan.remaining_by_seller_wh[seller.user_id]
        == 1000
    )


# ==================================================
# TEST 6 — Never allocate more than seller supply
# ==================================================

def test_never_oversells(
    matching_input,
    pair,
):

    buyer, seller = pair

    seller = make_seller(
        seller, supply_wh=7000
    )

    second_buyer = make_buyer(
        buyer, number=3, demand_wh=3000
    )

    third_buyer = make_buyer(
        buyer, number=4, demand_wh=2000
    )

    expanded = make_input(
        matching_input,
        third_buyer,
        second_buyer,
        seller,
        buyer,
    )

    plan = match_greedily(expanded)

    assert len(plan.matches) == 2

    allocated = sum(
        match.quantity_wh
        for match in plan.matches
    )

    assert allocated == 7000

    assert (
        plan.remaining_by_seller_wh[seller.user_id]
        == 0
    )

    assert plan.unmatched_buyer_ids == (
        third_buyer.user_id,
    )


# ==================================================
# TEST 7 — Equal demands use lexical buyer IDs
# ==================================================

def test_equal_buyer_demands_use_lexical_id(
    matching_input,
    pair,
):

    buyer, seller = pair

    other_buyer = make_buyer(
        buyer, number=3, demand_wh=4000
    )

    expanded = make_input(
        matching_input,
        other_buyer,
        seller,
        buyer,
    )

    plan = match_greedily(expanded)

    assert len(plan.matches) == 1

    assert plan.matches[0].buyer_id == buyer.user_id

    assert plan.unmatched_buyer_ids == (
        other_buyer.user_id,
    )


# ==================================================
# TEST 8 — Partial fulfillment is not allowed
# ==================================================

def test_rejects_partial_fulfillment(
    matching_input,
    pair,
):

    buyer, seller = pair

    small_seller = make_seller(
        seller, supply_wh=2000
    )

    expanded = make_input(
        matching_input,
        buyer,
        small_seller,
    )

    plan = match_greedily(expanded)

    assert plan.matches == ()

    assert plan.unmatched_buyer_ids == (
        buyer.user_id,
    )

    assert (
        plan.remaining_by_seller_wh[
            small_seller.user_id
        ] == 2000
    )


# ==================================================
# TEST 9 — Cannot combine two sellers for one buyer
# ==================================================

def test_cannot_split_buyer_across_sellers(
    matching_input,
    pair,
):

    buyer, seller = pair

    seller_one = make_seller(
        seller, supply_wh=2500
    )

    seller_two = make_seller(
        seller,
        supply_wh=2500,
        clone=True,
    )

    expanded = make_input(
        matching_input,
        buyer,
        seller_one,
        seller_two,
    )

    plan = match_greedily(expanded)

    assert plan.matches == ()

    assert plan.unmatched_buyer_ids == (
        buyer.user_id,
    )


# ==================================================
# TEST 10 — Choose highest-ranked eligible seller
# ==================================================

def test_chooses_highest_ranked_seller(
    matching_input,
    pair,
):

    buyer, seller = pair

    cheaper_seller = make_seller(
        seller,
        supply_wh=4000,
        clone=True,
        asking_price=100000,
    )

    expanded = make_input(
        matching_input,
        buyer,
        seller,
        cheaper_seller,
    )

    plan = match_greedily(expanded)

    assert len(plan.matches) == 1

    assert (
        plan.matches[0].seller_id
        == cheaper_seller.user_id
    )

    assert (
        plan.remaining_by_seller_wh[
            cheaper_seller.user_id
        ] == 0
    )

    assert (
        plan.remaining_by_seller_wh[
            seller.user_id
        ] == 4000
    )


# ==================================================
# TEST 11 — Handle markets without sellers
# ==================================================

def test_market_without_sellers(
    matching_input,
    pair,
):

    buyer, _ = pair

    expanded = make_input(
        matching_input,
        buyer,
    )

    plan = match_greedily(expanded)

    assert plan.matches == ()

    assert plan.unmatched_buyer_ids == (
        buyer.user_id,
    )

    assert dict(plan.remaining_by_seller_wh) == {}


# ==================================================
# TEST 12 — Handle markets without buyers
# ==================================================

def test_market_without_buyers(
    matching_input,
    pair,
):

    _, seller = pair

    expanded = make_input(
        matching_input,
        seller,
    )

    plan = match_greedily(expanded)

    assert plan.matches == ()
    assert plan.unmatched_buyer_ids == ()

    assert (
        plan.remaining_by_seller_wh[
            seller.user_id
        ] == seller.available_energy_wh
    )


# ==================================================
# TEST 13 — Incompatible buyers remain unmatched
# ==================================================

@pytest.mark.parametrize(
    "changes",
    [
        {"maxPriceMicrousdPerKwh": 130000},
        {"preferredEnergyType": "WIND"},
    ],
)
def test_ineligible_buyer_is_unmatched(
    matching_input,
    pair,
    changes,
):

    buyer, seller = pair

    incompatible_buyer = changed_record(
        buyer,
        **changes,
    )

    expanded = make_input(
        matching_input,
        incompatible_buyer,
        seller,
    )

    plan = match_greedily(expanded)

    assert plan.matches == ()

    assert plan.unmatched_buyer_ids == (
        buyer.user_id,
    )


# ==================================================
# TEST 14 — Input order does not affect matches
# ==================================================

def test_input_order_independent(
    matching_input,
    pair,
):

    buyer, seller = pair

    seller_two = make_seller(
        seller,
        supply_wh=4000,
        clone=True,
        asking_price=100000,
    )

    buyer_two = make_buyer(
        buyer, number=3, demand_wh=3000
    )

    first_input = make_input(
        matching_input,
        buyer,
        seller,
        buyer_two,
        seller_two,
    )

    second_input = make_input(
        matching_input,
        seller_two,
        buyer_two,
        seller,
        buyer,
    )

    first_plan = match_greedily(first_input)
    second_plan = match_greedily(second_input)

    assert first_plan == second_plan


# ==================================================
# TEST 15 — Repeated runs are deterministic
# ==================================================

def test_matching_is_deterministic(
    matching_input,
):

    first = match_greedily(matching_input)
    second = match_greedily(matching_input)

    assert first == second


# ==================================================
# TEST 16 — Matching does not modify its input
# ==================================================

def test_matching_does_not_mutate_input(
    matching_input,
    pair,
):

    _, seller = pair

    before = matching_input.model_dump(
        mode="json",
        by_alias=True,
    )

    plan = match_greedily(matching_input)

    after = matching_input.model_dump(
        mode="json",
        by_alias=True,
    )

    assert before == after

    assert seller.available_energy_wh == 4000

    # The returned inventory view is read-only.
    with pytest.raises(TypeError):
        plan.remaining_by_seller_wh[
            seller.user_id
        ] = 100


# ==================================================
# TEST 17 — Reject invalid MatchingInput objects
# ==================================================

def test_rejects_invalid_matching_input():

    with pytest.raises(
        TypeError,
        match="MatchingInput",
    ):
        match_greedily({})
