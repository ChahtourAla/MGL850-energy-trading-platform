
"""
Classify hourly electricity production and consumption
into P2P energy market positions.

A household can be:
- SELLER: produces more energy than it consumes.
- BUYER: consumes more energy than it produces.
- NEUTRAL: production and consumption are equal.

This module does not:
- Generate electricity.
- Assign energy sources.
- Calculate electricity prices.
- Create blockchain transactions.
"""

from dataclasses import dataclass

from p2p_energy_shared import MarketRole

from data_generator.energy_simulator import (
    EnergyQuantities,
)


# --------------------------------------------------
# 1. Represent a household's market position
# --------------------------------------------------

@dataclass(frozen=True)
class MarketPosition:

    market_role: MarketRole

    net_energy_wh: int

    available_energy_wh: int

    required_energy_wh: int


# --------------------------------------------------
# 2. Classify hourly electricity quantities
# --------------------------------------------------

def classify_market_position(
    quantities: EnergyQuantities,
) -> MarketPosition:
    """
    Determine one household's market role.

    Net energy = production - consumption.

    SELLER:
        net energy > 0
        available energy = net energy
        required energy = 0

    BUYER:
        net energy < 0
        available energy = 0
        required energy = -net energy

    NEUTRAL:
        net energy = 0
        available energy = 0
        required energy = 0
    """

    # --------------------------------------------------
    # 3. Check the input object
    # --------------------------------------------------

    if not isinstance(quantities, EnergyQuantities):
        raise TypeError(
            "quantities must be an EnergyQuantities object"
        )

    production_wh = quantities.production_wh
    consumption_wh = quantities.consumption_wh

    # --------------------------------------------------
    # 4. Validate electricity quantities
    # --------------------------------------------------

    for name, value in (
        ("production_wh", production_wh),
        ("consumption_wh", consumption_wh),
    ):

        # Reject floats, strings and booleans.
        if type(value) is not int:
            raise TypeError(
                f"{name} must be an integer"
            )

        # Electricity quantities cannot be negative.
        if value < 0:
            raise ValueError(
                f"{name} cannot be negative"
            )

    # --------------------------------------------------
    # 5. Calculate net electricity
    # --------------------------------------------------

    net_energy_wh = (
        production_wh - consumption_wh
    )

    # --------------------------------------------------
    # 6. Determine the market role
    # --------------------------------------------------

    if net_energy_wh > 0:

        market_role = MarketRole.SELLER

        available_energy_wh = net_energy_wh

        required_energy_wh = 0

    elif net_energy_wh < 0:

        market_role = MarketRole.BUYER

        available_energy_wh = 0

        required_energy_wh = -net_energy_wh

    else:

        market_role = MarketRole.NEUTRAL

        available_energy_wh = 0

        required_energy_wh = 0

    # --------------------------------------------------
    # 7. Return the validated classification
    # --------------------------------------------------

    return MarketPosition(
        market_role=market_role,
        net_energy_wh=net_energy_wh,
        available_energy_wh=available_energy_wh,
        required_energy_wh=required_energy_wh,
    )
