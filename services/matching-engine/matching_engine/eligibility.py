
"""
Buyer-seller eligibility checks for the Matching Engine.

This module filters incompatible pairs before scoring.

V1 uses full-buyer fulfillment:
one seller must have enough remaining energy to
satisfy the buyer's entire hourly demand.

No matching decisions or blockchain actions occur here.
"""

import math

from collections.abc import Mapping
from dataclasses import dataclass
from uuid import UUID

from p2p_energy_shared import (
    HourlyEnergyRecord,
    MarketRole,
    MatchingInput,
)


# --------------------------------------------------
# 1. Represent eligibility results
# --------------------------------------------------

@dataclass(frozen=True)
class EligibilityResult:
    eligible: bool
    distance_km: float | None = None
    reason: str | None = None


@dataclass(frozen=True)
class EligibleSeller:
    seller: HourlyEnergyRecord
    distance_km: float


# --------------------------------------------------
# 2. Calculate Euclidean distance
# --------------------------------------------------

def calculate_distance_km(
    buyer: HourlyEnergyRecord,
    seller: HourlyEnergyRecord,
) -> float:
    """
    Calculate distance in our simulated
    two-dimensional kilometre coordinate system.
    """

    if not isinstance(buyer, HourlyEnergyRecord):
        raise TypeError(
            "buyer must be an HourlyEnergyRecord"
        )

    if not isinstance(seller, HourlyEnergyRecord):
        raise TypeError(
            "seller must be an HourlyEnergyRecord"
        )

    return math.hypot(
        buyer.x_km - seller.x_km,
        buyer.y_km - seller.y_km,
    )


# --------------------------------------------------
# 3. Validate distance configuration
# --------------------------------------------------

def _validate_distance_limit(
    maximum_distance_km: float,
) -> None:

    if type(maximum_distance_km) not in (int, float):
        raise TypeError(
            "maximum_distance_km must be numeric"
        )

    if (
        not math.isfinite(maximum_distance_km)
        or maximum_distance_km <= 0
    ):
        raise ValueError(
            "maximum_distance_km must be "
            "finite and positive"
        )


# --------------------------------------------------
# 4. Check one buyer-seller pair
# --------------------------------------------------

def check_pair_eligibility(
    buyer: HourlyEnergyRecord,
    seller: HourlyEnergyRecord,
    maximum_distance_km: float,
    remaining_seller_wh: int | None = None,
) -> EligibilityResult:
    """
    Check whether a seller can fully satisfy a buyer.

    remaining_seller_wh:
        Optional current seller inventory.

        If omitted, use the seller's original
        availableEnergyWh.

        The greedy matcher will pass its updated
        remaining inventory after earlier trades.
    """

    if not isinstance(buyer, HourlyEnergyRecord):
        raise TypeError(
            "buyer must be an HourlyEnergyRecord"
        )

    if not isinstance(seller, HourlyEnergyRecord):
        raise TypeError(
            "seller must be an HourlyEnergyRecord"
        )

    _validate_distance_limit(maximum_distance_km)

    # ----------------------------------------------
    # A. Validate the supplied remaining inventory
    # ----------------------------------------------

    if remaining_seller_wh is not None:

        if type(remaining_seller_wh) is not int:
            raise TypeError(
                "remaining_seller_wh must be an integer"
            )

        if (
            remaining_seller_wh < 0
            or remaining_seller_wh
            > seller.available_energy_wh
        ):
            raise ValueError(
                "remaining_seller_wh must be between "
                "zero and seller.availableEnergyWh"
            )

    # ----------------------------------------------
    # B. Validate market roles
    # ----------------------------------------------

    if buyer.market_role != MarketRole.BUYER:
        return EligibilityResult(
            eligible=False,
            reason="BUYER_ROLE_REQUIRED",
        )

    if seller.market_role != MarketRole.SELLER:
        return EligibilityResult(
            eligible=False,
            reason="SELLER_ROLE_REQUIRED",
        )

    # ----------------------------------------------
    # C. Prevent self-trading
    # ----------------------------------------------

    if buyer.user_id == seller.user_id:
        return EligibilityResult(
            eligible=False,
            reason="SAME_USER",
        )

    if (
        buyer.evm_address.lower()
        == seller.evm_address.lower()
    ):
        return EligibilityResult(
            eligible=False,
            reason="SAME_WALLET",
        )

    # ----------------------------------------------
    # D. Require the same hourly market
    # ----------------------------------------------

    if buyer.time_slot != seller.time_slot:
        return EligibilityResult(
            eligible=False,
            reason="TIME_SLOT_MISMATCH",
        )

    # ----------------------------------------------
    # E. Check seller's remaining energy
    # ----------------------------------------------

    remaining = (
        seller.available_energy_wh
        if remaining_seller_wh is None
        else remaining_seller_wh
    )

    if remaining < buyer.required_energy_wh:
        return EligibilityResult(
            eligible=False,
            reason="INSUFFICIENT_ENERGY",
        )

    # ----------------------------------------------
    # F. Check price compatibility
    # ----------------------------------------------

    if (
        seller.ask_price_microusd_per_kwh
        > buyer.max_price_microusd_per_kwh
    ):
        return EligibilityResult(
            eligible=False,
            reason="PRICE_TOO_HIGH",
        )

    # ----------------------------------------------
    # G. Check buyer energy preference
    # ----------------------------------------------

    preference = buyer.preferred_energy_type.value
    seller_source = seller.energy_type.value

    if (
        preference != "ANY"
        and preference != seller_source
    ):
        return EligibilityResult(
            eligible=False,
            reason="ENERGY_TYPE_MISMATCH",
        )

    # ----------------------------------------------
    # H. Check geographic distance
    # ----------------------------------------------

    distance_km = calculate_distance_km(
        buyer,
        seller,
    )

    if distance_km > maximum_distance_km:
        return EligibilityResult(
            eligible=False,
            distance_km=distance_km,
            reason="DISTANCE_EXCEEDED",
        )

    # ----------------------------------------------
    # I. All conditions satisfied
    # ----------------------------------------------

    return EligibilityResult(
        eligible=True,
        distance_km=distance_km,
        reason=None,
    )


# --------------------------------------------------
# 5. Find eligible sellers for one buyer
# --------------------------------------------------

def find_eligible_sellers(
    matching_input: MatchingInput,
    buyer: HourlyEnergyRecord,
    remaining_by_seller: Mapping[UUID, int] | None = None,
) -> list[EligibleSeller]:
    """
    Return all eligible sellers for one buyer.

    Results are sorted by seller ID for deterministic
    enumeration. This is NOT the final matching rank.

    Step 12.2 will calculate scores, and Step 12.3
    will select the best available seller.
    """

    if not isinstance(matching_input, MatchingInput):
        raise TypeError(
            "matching_input must be a MatchingInput"
        )

    if not isinstance(buyer, HourlyEnergyRecord):
        raise TypeError(
            "buyer must be an HourlyEnergyRecord"
        )

    if (
        remaining_by_seller is not None
        and not isinstance(remaining_by_seller, Mapping)
    ):
        raise TypeError(
            "remaining_by_seller must be a mapping"
        )

    # The buyer must belong to this hourly input.
    if not any(
        record.user_id == buyer.user_id
        and record.market_role == MarketRole.BUYER
        for record in matching_input.users
    ):
        raise ValueError(
            "Buyer not found in MatchingInput"
        )

    candidates = []

    for seller in matching_input.users:

        if seller.market_role != MarketRole.SELLER:
            continue

        remaining = (
            None
            if remaining_by_seller is None
            else remaining_by_seller.get(seller.user_id)
        )

        result = check_pair_eligibility(
            buyer=buyer,
            seller=seller,
            maximum_distance_km=(
                matching_input.maximum_distance_km
            ),
            remaining_seller_wh=remaining,
        )

        if result.eligible:
            candidates.append(
                EligibleSeller(
                    seller=seller,
                    distance_km=result.distance_km,
                )
            )

    # Stable enumeration only.
    # Scores will determine actual ranking later.
    return sorted(
        candidates,
        key=lambda candidate: str(
            candidate.seller.user_id
        ),
    )
