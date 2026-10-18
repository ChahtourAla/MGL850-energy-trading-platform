
"""
Convert greedy allocations into validated MatchingOutput.

Responsibilities:
- Verify the allocation plan.
- Preserve buyer and seller identities.
- Calculate total payment amounts.
- Generate deterministic match IDs.
- Attach UTC creation timestamps.
- Construct validated shared Pydantic models.

No blockchain calls or database operations.
"""

import math

from datetime import datetime, timezone
from uuid import uuid5

from p2p_energy_shared import (
    MatchResult,
    MatchingInput,
    MatchingOutput,
    MarketRole,
)

from matching_engine.greedy import (
    GreedyMatchingPlan,
)

from matching_engine.scoring import (
    calculate_pair_score,
)


# --------------------------------------------------
# 1. Convert Wh and micro-USD/kWh to micro-USD
# --------------------------------------------------

def calculate_total_amount_microusd(
    quantity_wh: int,
    unit_price_microusd_per_kwh: int,
) -> int:
    """
    Convert quantity × unit price into micro-USD.

    1 kWh = 1000 Wh.

    Fractional micro-USD is rounded down using
    integer arithmetic for the V1 prototype.
    """

    if type(quantity_wh) is not int:
        raise TypeError(
            "quantity_wh must be an integer"
        )

    if type(unit_price_microusd_per_kwh) is not int:
        raise TypeError(
            "unit_price_microusd_per_kwh must be an integer"
        )

    if quantity_wh <= 0:
        raise ValueError(
            "quantity_wh must be positive"
        )

    if unit_price_microusd_per_kwh <= 0:
        raise ValueError(
            "unit_price_microusd_per_kwh must be positive"
        )

    return (
        quantity_wh * unit_price_microusd_per_kwh
    ) // 1000


# --------------------------------------------------
# 2. Construct the final MatchingOutput
# --------------------------------------------------

def build_matching_output(
    matching_input: MatchingInput,
    plan: GreedyMatchingPlan,
    *,
    execution_time_ms: int = 0,
    created_at: datetime | None = None,
) -> MatchingOutput:
    """
    Convert a GreedyMatchingPlan into MatchingOutput.

    execution_time_ms:
        Measured execution time supplied by the caller.
        The CLI will measure this in Step 12.5.

    created_at:
        Optional timezone-aware creation timestamp.
        Defaults to the current UTC time.
        Tests may provide a fixed timestamp.
    """

    # ----------------------------------------------
    # A. Validate arguments
    # ----------------------------------------------

    if not isinstance(matching_input, MatchingInput):
        raise TypeError(
            "matching_input must be a MatchingInput"
        )

    if not isinstance(plan, GreedyMatchingPlan):
        raise TypeError(
            "plan must be a GreedyMatchingPlan"
        )

    if type(execution_time_ms) is not int:
        raise TypeError(
            "execution_time_ms must be an integer"
        )

    if execution_time_ms < 0:
        raise ValueError(
            "execution_time_ms cannot be negative"
        )

    timestamp = (
        datetime.now(timezone.utc)
        if created_at is None
        else created_at
    )

    if not isinstance(timestamp, datetime):
        raise TypeError(
            "created_at must be a datetime"
        )

    if (
        timestamp.tzinfo is None
        or timestamp.utcoffset() is None
    ):
        raise ValueError(
            "created_at must include timezone information"
        )

    timestamp = timestamp.astimezone(timezone.utc)

    # ----------------------------------------------
    # B. Index buyers and sellers
    # ----------------------------------------------

    buyers = {
        user.user_id: user
        for user in matching_input.users
        if user.market_role == MarketRole.BUYER
    }

    sellers = {
        user.user_id: user
        for user in matching_input.users
        if user.market_role == MarketRole.SELLER
    }

    # Independently track the allocation amounts
    # to verify that the plan has not oversold.
    remaining = {
        seller_id: seller.available_energy_wh
        for seller_id, seller in sellers.items()
    }

    matched_buyer_ids = set()
    results = []

    # ----------------------------------------------
    # C. Validate and convert each planned match
    # ----------------------------------------------

    for allocation in plan.matches:

        buyer = buyers.get(allocation.buyer_id)
        seller = sellers.get(allocation.seller_id)

        if buyer is None or seller is None:
            raise ValueError(
                "Plan references an unknown buyer or seller"
            )

        if allocation.buyer_id in matched_buyer_ids:
            raise ValueError(
                "A buyer cannot be matched more than once"
            )

        if (
            allocation.quantity_wh
            != buyer.required_energy_wh
        ):
            raise ValueError(
                "Planned quantity must fully satisfy buyer"
            )

        if (
            allocation.unit_price_microusd_per_kwh
            != seller.ask_price_microusd_per_kwh
        ):
            raise ValueError(
                "Planned price differs from seller asking price"
            )

        # Recheck eligibility and the score using
        # remaining seller inventory at this point.
        expected = calculate_pair_score(
            buyer=buyer,
            seller=seller,
            matching_input=matching_input,
            remaining_seller_wh=remaining[
                seller.user_id
            ],
        )

        if not math.isclose(
            allocation.score,
            expected.score.final_score,
            rel_tol=0.0,
            abs_tol=1e-12,
        ):
            raise ValueError(
                "Planned matching score is inconsistent"
            )

        if not math.isclose(
            allocation.distance_km,
            expected.distance_km,
            rel_tol=0.0,
            abs_tol=1e-12,
        ):
            raise ValueError(
                "Planned matching distance is inconsistent"
            )

        # ------------------------------------------
        # D. Create deterministic match ID
        # ------------------------------------------

        match_id = uuid5(
            matching_input.snapshot_id,
            (
                f"match:{matching_input.algorithm_version}:"
                f"{buyer.user_id}:{seller.user_id}:"
                f"{allocation.quantity_wh}:"
                f"{allocation.unit_price_microusd_per_kwh}"
            ),
        )

        # ------------------------------------------
        # E. Calculate total energy payment
        # ------------------------------------------

        total_amount = calculate_total_amount_microusd(
            allocation.quantity_wh,
            allocation.unit_price_microusd_per_kwh,
        )

        # ------------------------------------------
        # F. Create validated MatchResult
        # ------------------------------------------

        match = MatchResult(
            matchId=match_id,
            algorithmVersion=(
                matching_input.algorithm_version
            ),
            timeSlot=matching_input.time_slot,
            buyerId=buyer.user_id,
            buyerWallet=buyer.evm_address,
            sellerId=seller.user_id,
            sellerWallet=seller.evm_address,
            quantityWh=allocation.quantity_wh,
            unitPriceMicrousdPerKwh=(
                allocation.unit_price_microusd_per_kwh
            ),
            totalAmountMicrousd=total_amount,
            distanceKm=allocation.distance_km,
            score=allocation.score,
            sellerEnergyType=seller.energy_type,
            createdAt=timestamp.isoformat().replace("+00:00", "Z"),
        )

        results.append(match)

        matched_buyer_ids.add(buyer.user_id)

        remaining[seller.user_id] -= (
            allocation.quantity_wh
        )

    # ----------------------------------------------
    # G. Verify the complete matching plan
    # ----------------------------------------------

    unmatched_ids = tuple(
        plan.unmatched_buyer_ids
    )

    if len(unmatched_ids) != len(set(unmatched_ids)):
        raise ValueError(
            "Duplicate unmatched buyer IDs"
        )

    expected_unmatched = (
        set(buyers) - matched_buyer_ids
    )

    if set(unmatched_ids) != expected_unmatched:
        raise ValueError(
            "Unmatched buyer IDs are inconsistent"
        )

    if dict(plan.remaining_by_seller_wh) != remaining:
        raise ValueError(
            "Seller remaining inventory is inconsistent"
        )

    # ----------------------------------------------
    # H. Create validated MatchingOutput
    # ----------------------------------------------

    return MatchingOutput(
        schemaVersion=matching_input.schema_version,
        snapshotId=matching_input.snapshot_id,
        timeSlot=matching_input.time_slot,
        algorithmVersion=matching_input.algorithm_version,
        executionTimeMs=execution_time_ms,
        matches=results,
        unmatchedBuyerIds=list(unmatched_ids),
        warnings=[],
    )
