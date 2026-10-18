
"""
Deterministic energy source assignment and market pricing.

This module:
- Assigns an installed electricity production source.
- Generates seller asking prices.
- Generates buyer maximum buying prices.
- Produces market terms compatible with HourlyEnergyRecord.

It does not create wallets or blockchain transactions.
"""

import hashlib
import random

from dataclasses import dataclass

from p2p_energy_shared import (
    EnergyType,
    MarketRole,
    User,
)

from data_generator.energy_config import (
    EnergyGenerationConfig,
)

from data_generator.energy_simulator import (
    get_utc_hour,
)

from data_generator.market_roles import (
    MarketPosition,
)


# --------------------------------------------------
# 1. Represent a user's hourly market terms
# --------------------------------------------------

@dataclass(frozen=True)
class MarketTerms:

    energy_type: EnergyType | None

    ask_price_microusd_per_kwh: int | None

    max_price_microusd_per_kwh: int | None


# --------------------------------------------------
# 2. Create a deterministic random generator
# --------------------------------------------------

def _make_rng(
    user: User,
    config: EnergyGenerationConfig,
    channel: str,
    time_slot: str = "",
) -> random.Random:
    """
    Generate an independent, reproducible random stream.

    Different channels prevent source selection and
    pricing from influencing each other's results.
    """

    key = (
        f"p2p-energy-market|{config.seed}|"
        f"{user.user_id}|{channel}|{time_slot}"
    )

    digest = hashlib.sha256(
        key.encode("utf-8")
    ).digest()

    stable_seed = int.from_bytes(
        digest[:16],
        byteorder="big",
    )

    return random.Random(stable_seed)


# --------------------------------------------------
# 3. Assign an installed production energy source
# --------------------------------------------------

def assign_production_energy_type(
    user: User,
    config: EnergyGenerationConfig,
    has_local_generation: bool = True,
) -> EnergyType | None:
    """
    Choose one production technology for a household.

    The assignment depends on the configuration
    weights, seed and user ID, but NOT on the hour.

    If the household has no local generation,
    return None.
    """

    if type(has_local_generation) is not bool:
        raise TypeError(
            "has_local_generation must be a boolean"
        )

    if not has_local_generation:
        return None

    weights = config.production_energy_type_weights

    energy_types = [
        EnergyType.SOLAR,
        EnergyType.WIND,
        EnergyType.HYDRO,
        EnergyType.GRID,
        EnergyType.MIXED,
    ]

    probabilities = [
        weights.solar,
        weights.wind,
        weights.hydro,
        weights.grid,
        weights.mixed,
    ]

    rng = _make_rng(
        user=user,
        config=config,
        channel="installed-energy-source",
    )

    selected = rng.choices(
        population=energy_types,
        weights=probabilities,
        k=1,
    )[0]

    return selected


# --------------------------------------------------
# 4. Generate a seller or buyer price
# --------------------------------------------------

def generate_market_terms(
    user: User,
    time_slot: str,
    config: EnergyGenerationConfig,
    position: MarketPosition,
    production_energy_type: EnergyType | None,
) -> MarketTerms:
    """
    Generate valid market terms for one user and hour.

    SELLER:
        energyType = actual production technology
        askPrice = generated positive price
        maxPrice = None

    BUYER:
        energyType = None
        askPrice = None
        maxPrice = generated positive price

    NEUTRAL:
        All market fields are None.
    """

    # ----------------------------------------------
    # 5. Validate the time slot and inputs
    # ----------------------------------------------

    get_utc_hour(time_slot)

    if not isinstance(position, MarketPosition):
        raise TypeError(
            "position must be a MarketPosition"
        )

    if (
        production_energy_type is not None
        and not isinstance(
            production_energy_type,
            EnergyType,
        )
    ):
        raise TypeError(
            "production_energy_type must be "
            "EnergyType or None"
        )

    # ----------------------------------------------
    # 6. Generate terms for a SELLER
    # ----------------------------------------------

    if position.market_role == MarketRole.SELLER:

        if production_energy_type is None:
            raise ValueError(
                "A SELLER must have a production "
                "energy source"
            )

        price_range = config.seller_ask_price_range

        rng = _make_rng(
            user=user,
            config=config,
            channel="seller-ask-price",
            time_slot=time_slot,
        )

        asking_price = rng.randint(
            price_range.minimum,
            price_range.maximum,
        )

        return MarketTerms(
            energy_type=production_energy_type,
            ask_price_microusd_per_kwh=asking_price,
            max_price_microusd_per_kwh=None,
        )

    # ----------------------------------------------
    # 7. Generate terms for a BUYER
    # ----------------------------------------------

    if position.market_role == MarketRole.BUYER:

        price_range = config.buyer_max_price_range

        rng = _make_rng(
            user=user,
            config=config,
            channel="buyer-max-price",
            time_slot=time_slot,
        )

        maximum_price = rng.randint(
            price_range.minimum,
            price_range.maximum,
        )

        return MarketTerms(
            energy_type=None,
            ask_price_microusd_per_kwh=None,
            max_price_microusd_per_kwh=maximum_price,
        )

    # ----------------------------------------------
    # 8. A NEUTRAL user has no market offer
    # ----------------------------------------------

    return MarketTerms(
        energy_type=None,
        ask_price_microusd_per_kwh=None,
        max_price_microusd_per_kwh=None,
    )
