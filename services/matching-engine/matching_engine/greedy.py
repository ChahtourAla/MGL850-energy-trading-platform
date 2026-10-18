
"""
Deterministic greedy energy matching algorithm.

Version 1 rules:
- Process buyers by descending energy requirement.
- Resolve equal buyer requirements by lexical user ID.
- Rank eligible sellers using weighted scores.
- Allocate one buyer's full requirement to one seller.
- Deduct allocated energy from seller inventory.
- Never oversell.
- Record buyers who cannot be matched.

This module produces an intermediate matching plan.
MatchingOutput serialization comes in Step 12.4.
"""

from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType
from uuid import UUID

from p2p_energy_shared import (
    MarketRole,
    MatchingInput,
)

from matching_engine.scoring import (
    rank_eligible_sellers,
)


# --------------------------------------------------
# 1. Represent a selected allocation
# --------------------------------------------------

@dataclass(frozen=True)
class PlannedMatch:

    buyer_id: UUID
    seller_id: UUID

    quantity_wh: int
    unit_price_microusd_per_kwh: int

    distance_km: float
    score: float


# --------------------------------------------------
# 2. Represent the matching plan
# --------------------------------------------------

@dataclass(frozen=True)
class GreedyMatchingPlan:

    matches: tuple[PlannedMatch, ...]

    unmatched_buyer_ids: tuple[UUID, ...]

    remaining_by_seller_wh: Mapping[UUID, int]


# --------------------------------------------------
# 3. Execute the greedy matching algorithm
# --------------------------------------------------

def match_greedily(
    matching_input: MatchingInput,
) -> GreedyMatchingPlan:
    """
    Produce an ordered sequence of full-buyer matches.

    Does not modify MatchingInput or any original
    HourlyEnergyRecord.

    Inventory is tracked locally during execution.
    """

    # ----------------------------------------------
    # A. Validate input
    # ----------------------------------------------

    if not isinstance(matching_input, MatchingInput):
        raise TypeError(
            "matching_input must be a MatchingInput"
        )

    # ----------------------------------------------
    # B. Find buyers and sellers
    # ----------------------------------------------

    buyers = [
        record
        for record in matching_input.users
        if record.market_role == MarketRole.BUYER
    ]

    sellers = [
        record
        for record in matching_input.users
        if record.market_role == MarketRole.SELLER
    ]

    # ----------------------------------------------
    # C. Initialize seller energy inventory
    # ----------------------------------------------

    remaining_by_seller = {
        seller.user_id: seller.available_energy_wh
        for seller in sellers
    }

    # ----------------------------------------------
    # D. Order buyers by descending demand
    # ----------------------------------------------

    ordered_buyers = sorted(
        buyers,
        key=lambda buyer: (
            -buyer.required_energy_wh,
            str(buyer.user_id),
        ),
    )

    selected_matches = []
    unmatched_buyer_ids = []

    # ----------------------------------------------
    # E. Process one buyer at a time
    # ----------------------------------------------

    for buyer in ordered_buyers:

        # Use the CURRENT inventory, not the
        # original seller availability.
        ranked_sellers = rank_eligible_sellers(
            matching_input=matching_input,
            buyer=buyer,
            remaining_by_seller=remaining_by_seller,
        )

        # No seller can satisfy this buyer.
        if not ranked_sellers:

            unmatched_buyer_ids.append(
                buyer.user_id
            )

            continue

        # ------------------------------------------
        # F. Select the highest-ranked seller
        # ------------------------------------------

        best_candidate = ranked_sellers[0]

        seller = best_candidate.seller

        quantity_wh = buyer.required_energy_wh

        available_wh = remaining_by_seller[
            seller.user_id
        ]

        # Defensive check against any accidental
        # inventory inconsistency.
        if quantity_wh > available_wh:
            raise RuntimeError(
                "Matching attempted to oversell "
                "seller inventory"
            )

        # ------------------------------------------
        # G. Record the selected allocation
        # ------------------------------------------

        selected_matches.append(
            PlannedMatch(
                buyer_id=buyer.user_id,
                seller_id=seller.user_id,
                quantity_wh=quantity_wh,
                unit_price_microusd_per_kwh=(
                    seller.ask_price_microusd_per_kwh
                ),
                distance_km=(
                    best_candidate.distance_km
                ),
                score=(
                    best_candidate.score.final_score
                ),
            )
        )

        # ------------------------------------------
        # H. Deduct energy immediately
        # ------------------------------------------

        remaining_by_seller[seller.user_id] = (
            available_wh - quantity_wh
        )

    # ----------------------------------------------
    # I. Return the complete allocation plan
    # ----------------------------------------------

    return GreedyMatchingPlan(
        matches=tuple(selected_matches),
        unmatched_buyer_ids=tuple(
            unmatched_buyer_ids
        ),
        remaining_by_seller_wh=MappingProxyType(
            remaining_by_seller.copy()
        ),
    )
