
"""
Weighted buyer-seller matching scores.

Scoring occurs only after eligibility filtering.

The four components are:
- Quantity compatibility
- Price attractiveness
- Geographic proximity
- Seller reputation

This module ranks eligible sellers but does not
allocate electricity or create trades.
"""

from collections.abc import Mapping
from dataclasses import dataclass
from uuid import UUID

from p2p_energy_shared import (
    HourlyEnergyRecord,
    MatchingInput,
)

from matching_engine.eligibility import (
    check_pair_eligibility,
    find_eligible_sellers,
)


# --------------------------------------------------
# 1. Represent the score components
# --------------------------------------------------

@dataclass(frozen=True)
class ScoreBreakdown:

    quantity_score: float
    price_score: float
    distance_score: float
    reputation_score: float
    final_score: float


@dataclass(frozen=True)
class ScoredSeller:

    seller: HourlyEnergyRecord
    distance_km: float
    score: ScoreBreakdown


# --------------------------------------------------
# 2. Clamp normalized values into [0, 1]
# --------------------------------------------------

def _clamp(value: float) -> float:

    return max(0.0, min(1.0, value))


# --------------------------------------------------
# 3. Calculate the score for one eligible pair
# --------------------------------------------------

def calculate_pair_score(
    buyer: HourlyEnergyRecord,
    seller: HourlyEnergyRecord,
    matching_input: MatchingInput,
    remaining_seller_wh: int | None = None,
) -> ScoredSeller:
    """
    Calculate all scoring components for an
    eligible buyer-seller pair.

    Uses seller remaining inventory, not merely
    the original available energy.

    Raises ValueError if the pair is ineligible.
    """

    if not isinstance(matching_input, MatchingInput):
        raise TypeError(
            "matching_input must be a MatchingInput"
        )

    # ----------------------------------------------
    # A. Validate the pair before scoring
    # ----------------------------------------------

    eligibility = check_pair_eligibility(
        buyer=buyer,
        seller=seller,
        maximum_distance_km=(
            matching_input.maximum_distance_km
        ),
        remaining_seller_wh=remaining_seller_wh,
    )

    if not eligibility.eligible:
        raise ValueError(
            "Buyer-seller pair is not eligible: "
            f"{eligibility.reason}"
        )

    # At this point eligibility guarantees
    # that distance_km is available.
    distance_km = eligibility.distance_km

    remaining_wh = (
        seller.available_energy_wh
        if remaining_seller_wh is None
        else remaining_seller_wh
    )

    # ----------------------------------------------
    # B. Quantity compatibility
    # ----------------------------------------------

    quantity_score = _clamp(
        buyer.required_energy_wh / remaining_wh
    )

    # ----------------------------------------------
    # C. Price attractiveness
    # ----------------------------------------------

    price_score = _clamp(
        1.0 - (
            seller.ask_price_microusd_per_kwh
            / buyer.max_price_microusd_per_kwh
        )
    )

    # ----------------------------------------------
    # D. Distance proximity
    # ----------------------------------------------

    distance_score = _clamp(
        1.0 - (
            distance_km
            / matching_input.maximum_distance_km
        )
    )

    # ----------------------------------------------
    # E. Seller reputation
    # ----------------------------------------------

    reputation_score = _clamp(
        seller.reputation / 100.0
    )

    # ----------------------------------------------
    # F. Weighted final score
    # ----------------------------------------------

    weights = matching_input.scoring_weights

    final_score = _clamp(
        weights.quantity * quantity_score
        + weights.price * price_score
        + weights.distance * distance_score
        + weights.reputation * reputation_score
    )

    breakdown = ScoreBreakdown(
        quantity_score=quantity_score,
        price_score=price_score,
        distance_score=distance_score,
        reputation_score=reputation_score,
        final_score=final_score,
    )

    return ScoredSeller(
        seller=seller,
        distance_km=distance_km,
        score=breakdown,
    )


# --------------------------------------------------
# 4. Sort scored sellers with deterministic tie-breaks
# --------------------------------------------------

def sort_scored_sellers(
    candidates: list[ScoredSeller],
) -> list[ScoredSeller]:
    """
    Ranking order:

    1. Highest final score
    2. Lowest seller asking price
    3. Shortest distance
    4. Lowest seller UUID in lexical order

    Scores and distances are not rounded.
    """

    if not isinstance(candidates, list):
        raise TypeError(
            "candidates must be a list"
        )

    if not all(
        isinstance(candidate, ScoredSeller)
        for candidate in candidates
    ):
        raise TypeError(
            "All candidates must be ScoredSeller objects"
        )

    return sorted(
        candidates,
        key=lambda candidate: (
            -candidate.score.final_score,
            candidate.seller.ask_price_microusd_per_kwh,
            candidate.distance_km,
            str(candidate.seller.user_id),
        ),
    )


# --------------------------------------------------
# 5. Rank all eligible sellers for one buyer
# --------------------------------------------------

def rank_eligible_sellers(
    matching_input: MatchingInput,
    buyer: HourlyEnergyRecord,
    remaining_by_seller: Mapping[UUID, int] | None = None,
) -> list[ScoredSeller]:
    """
    Find eligible sellers, calculate their scores,
    and return them in ranked order.

    No energy inventory is changed here.

    The greedy matching algorithm will use this
    function in Step 12.3.
    """

    # Reuse all eligibility checks from Step 12.1.
    eligible = find_eligible_sellers(
        matching_input=matching_input,
        buyer=buyer,
        remaining_by_seller=remaining_by_seller,
    )

    scored = []

    for candidate in eligible:

        seller = candidate.seller

        remaining_wh = (
            None
            if remaining_by_seller is None
            else remaining_by_seller.get(
                seller.user_id
            )
        )

        result = calculate_pair_score(
            buyer=buyer,
            seller=seller,
            matching_input=matching_input,
            remaining_seller_wh=remaining_wh,
        )

        scored.append(result)

    return sort_scored_sellers(scored)
