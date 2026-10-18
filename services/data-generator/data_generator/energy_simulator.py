
"""
Deterministic hourly electricity simulation.

Calculates production and consumption quantities
for one household during one UTC hour.

This module does not:
- Assign BUYER, SELLER, or NEUTRAL roles.
- Generate energy prices.
- Create blockchain wallets.
- Write EnergySnapshot files.
"""

import hashlib
import random

from dataclasses import dataclass
from uuid import UUID

from pydantic import TypeAdapter

from p2p_energy_shared import (
    EnergyType,
    User,
)

from p2p_energy_shared.energy_models import HourTimeSlot

from data_generator.energy_config import (
    EnergyGenerationConfig,
)


# --------------------------------------------------
# 1. Represent the simulated energy quantities
# --------------------------------------------------

@dataclass(frozen=True)
class EnergyQuantities:
    production_wh: int
    consumption_wh: int

    @property
    def net_energy_wh(self) -> int:
        return (
            self.production_wh
            - self.consumption_wh
        )


# --------------------------------------------------
# 2. Validate the UTC hour
# --------------------------------------------------

HOUR_SLOT_ADAPTER = TypeAdapter(HourTimeSlot)


def get_utc_hour(time_slot: str) -> int:
    """
    Validate the same hourly timestamp format
    used by our shared EnergySnapshot models.
    """

    validated_slot = HOUR_SLOT_ADAPTER.validate_python(
        time_slot
    )

    # Example: 2026-10-18T12:00:00Z
    #                    ^^
    return int(validated_slot[11:13])


# --------------------------------------------------
# 3. Build deterministic random variation
# --------------------------------------------------

def random_variation(
    seed: int,
    user_id: UUID,
    time_slot: str,
    channel: str,
    maximum_fraction: float,
) -> float:
    """
    Return a reproducible random variation
    between -maximum_fraction and +maximum_fraction.

    The result depends on:
    - Configuration seed
    - User ID
    - UTC time slot
    - Production or consumption channel
    """

    key = (
        f"{seed}|{user_id}|"
        f"{time_slot}|{channel}"
    )

    digest = hashlib.sha256(
        key.encode("utf-8")
    ).digest()

    stable_seed = int.from_bytes(
        digest[:16],
        byteorder="big",
    )

    rng = random.Random(stable_seed)

    return rng.uniform(
        -maximum_fraction,
        maximum_fraction,
    )


# --------------------------------------------------
# 4. Calculate hourly electricity production
# --------------------------------------------------

def calculate_hourly_production_wh(
    user: User,
    time_slot: str,
    config: EnergyGenerationConfig,
    energy_type: EnergyType | None,
) -> int:
    """
    Calculate energy produced in Wh for one hour.

    SOLAR:
        Uses the configured solar daily profile.

    WIND / HYDRO / GRID / MIXED:
        Uses the configured non-solar baseline.

    None:
        The household has no local generation.
    """

    hour = get_utc_hour(time_slot)

    if (
        energy_type is not None
        and not isinstance(energy_type, EnergyType)
    ):
        raise TypeError(
            "energy_type must be EnergyType or None"
        )

    # A consumption-only household does not
    # generate electricity.
    if energy_type is None:
        return 0

    if energy_type == EnergyType.SOLAR:

        solar_factor = (
            config.solar_production_profile[hour]
        )

        reference_production = (
            config.peak_solar_production_wh
            * solar_factor
        )

    else:

        # Simplified V1 model:
        # non-solar technologies use the same
        # configurable reference production.
        reference_production = (
            config.base_non_solar_production_wh
        )

    # If the production profile is zero,
    # do not introduce artificial production.
    if reference_production == 0:
        return 0

    variation = random_variation(
        seed=config.seed,
        user_id=user.user_id,
        time_slot=time_slot,
        channel="production",
        maximum_fraction=(
            config.production_variation_fraction
        ),
    )

    production_wh = round(
        reference_production * (1 + variation)
    )

    return max(0, production_wh)


# --------------------------------------------------
# 5. Calculate hourly electricity consumption
# --------------------------------------------------

def calculate_hourly_consumption_wh(
    user: User,
    time_slot: str,
    config: EnergyGenerationConfig,
) -> int:
    """
    Calculate electricity consumed during one hour.

    Uses the 24-hour consumption profile
    and reproducible random variation.
    """

    hour = get_utc_hour(time_slot)

    consumption_factor = (
        config.consumption_profile[hour]
    )

    reference_consumption = (
        config.base_consumption_wh
        * consumption_factor
    )

    if reference_consumption == 0:
        return 0

    variation = random_variation(
        seed=config.seed,
        user_id=user.user_id,
        time_slot=time_slot,
        channel="consumption",
        maximum_fraction=(
            config.consumption_variation_fraction
        ),
    )

    consumption_wh = round(
        reference_consumption * (1 + variation)
    )

    return max(0, consumption_wh)


# --------------------------------------------------
# 6. Simulate production and consumption together
# --------------------------------------------------

def simulate_hourly_quantities(
    user: User,
    time_slot: str,
    config: EnergyGenerationConfig,
    energy_type: EnergyType | None,
) -> EnergyQuantities:
    """
    Return all energy quantities for one user/hour.

    Market classification will be added in Step 8.
    """

    production_wh = calculate_hourly_production_wh(
        user=user,
        time_slot=time_slot,
        config=config,
        energy_type=energy_type,
    )

    consumption_wh = calculate_hourly_consumption_wh(
        user=user,
        time_slot=time_slot,
        config=config,
    )

    return EnergyQuantities(
        production_wh=production_wh,
        consumption_wh=consumption_wh,
    )
