
"""
Tests for electricity market role classification.
"""

from dataclasses import FrozenInstanceError
from pathlib import Path

import pytest

from p2p_energy_shared import (
    EnergyType,
    MarketRole,
)

from data_generator.energy_config import (
    load_energy_config,
)

from data_generator.energy_simulator import (
    EnergyQuantities,
    simulate_hourly_quantities,
)

from data_generator.market_roles import (
    MarketPosition,
    classify_market_position,
)

from data_generator.registry import (
    load_user_registry,
)


# --------------------------------------------------
# 1. Load existing configuration and sample user
# --------------------------------------------------

ROOT = Path(__file__).resolve().parents[3]

CONFIG_PATH = (
    ROOT
    / "services"
    / "data-generator"
    / "config"
    / "energy-generation-config.json"
)

REGISTRY_PATH = (
    ROOT
    / "packages"
    / "shared"
    / "fixtures"
    / "user-registry.sample.json"
)


@pytest.fixture
def config():
    return load_energy_config(CONFIG_PATH)


@pytest.fixture
def user():
    registry = load_user_registry(REGISTRY_PATH)
    return registry.users[0]


# --------------------------------------------------
# TEST 1 — A surplus creates a SELLER
# --------------------------------------------------

def test_classifies_seller():

    quantities = EnergyQuantities(
        production_wh=6000,
        consumption_wh=2000,
    )

    position = classify_market_position(
        quantities
    )

    assert position.market_role == MarketRole.SELLER
    assert position.net_energy_wh == 4000
    assert position.available_energy_wh == 4000
    assert position.required_energy_wh == 0


# --------------------------------------------------
# TEST 2 — A deficit creates a BUYER
# --------------------------------------------------

def test_classifies_buyer():

    quantities = EnergyQuantities(
        production_wh=1000,
        consumption_wh=3000,
    )

    position = classify_market_position(
        quantities
    )

    assert position.market_role == MarketRole.BUYER
    assert position.net_energy_wh == -2000
    assert position.available_energy_wh == 0
    assert position.required_energy_wh == 2000


# --------------------------------------------------
# TEST 3 — Equal quantities create a NEUTRAL user
# --------------------------------------------------

def test_classifies_neutral():

    quantities = EnergyQuantities(
        production_wh=2000,
        consumption_wh=2000,
    )

    position = classify_market_position(
        quantities
    )

    assert position.market_role == MarketRole.NEUTRAL
    assert position.net_energy_wh == 0
    assert position.available_energy_wh == 0
    assert position.required_energy_wh == 0


# --------------------------------------------------
# TEST 4 — One Wh difference is handled correctly
# --------------------------------------------------

@pytest.mark.parametrize(
    "production,consumption,role,available,required",
    [
        (1001, 1000, MarketRole.SELLER, 1, 0),
        (1000, 1001, MarketRole.BUYER, 0, 1),
    ],
)
def test_one_wh_difference(
    production,
    consumption,
    role,
    available,
    required,
):

    position = classify_market_position(
        EnergyQuantities(
            production_wh=production,
            consumption_wh=consumption,
        )
    )

    assert position.market_role == role
    assert position.available_energy_wh == available
    assert position.required_energy_wh == required


# --------------------------------------------------
# TEST 5 — Solar production creates a midday seller
# --------------------------------------------------

def test_solar_household_sells_at_midday(
    user,
    config,
):

    no_variation = config.model_copy(
        update={
            "production_variation_fraction": 0.0,
            "consumption_variation_fraction": 0.0,
        }
    )

    quantities = simulate_hourly_quantities(
        user=user,
        time_slot="2026-10-18T12:00:00Z",
        config=no_variation,
        energy_type=EnergyType.SOLAR,
    )

    position = classify_market_position(
        quantities
    )

    assert position.market_role == MarketRole.SELLER
    assert position.available_energy_wh == 4375
    assert position.required_energy_wh == 0


# --------------------------------------------------
# TEST 6 — Solar household becomes buyer at night
# --------------------------------------------------

def test_solar_household_buys_at_night(
    user,
    config,
):

    quantities = simulate_hourly_quantities(
        user=user,
        time_slot="2026-10-18T23:00:00Z",
        config=config,
        energy_type=EnergyType.SOLAR,
    )

    position = classify_market_position(
        quantities
    )

    assert quantities.production_wh == 0
    assert position.market_role == MarketRole.BUYER
    assert position.available_energy_wh == 0
    assert position.required_energy_wh > 0


# --------------------------------------------------
# TEST 7 — Household without generation is a buyer
# --------------------------------------------------

def test_consumption_only_household_is_buyer(
    user,
    config,
):

    quantities = simulate_hourly_quantities(
        user=user,
        time_slot="2026-10-18T12:00:00Z",
        config=config,
        energy_type=None,
    )

    position = classify_market_position(
        quantities
    )

    assert quantities.production_wh == 0
    assert position.market_role == MarketRole.BUYER


# --------------------------------------------------
# TEST 8 — Market roles change between hours
# --------------------------------------------------

def test_same_household_can_change_roles(
    user,
    config,
):

    no_variation = config.model_copy(
        update={
            "production_variation_fraction": 0.0,
            "consumption_variation_fraction": 0.0,
        }
    )

    midday = simulate_hourly_quantities(
        user,
        "2026-10-18T12:00:00Z",
        no_variation,
        EnergyType.SOLAR,
    )

    evening = simulate_hourly_quantities(
        user,
        "2026-10-18T20:00:00Z",
        no_variation,
        EnergyType.SOLAR,
    )

    midday_position = classify_market_position(
        midday
    )

    evening_position = classify_market_position(
        evening
    )

    assert midday_position.market_role == MarketRole.SELLER
    assert evening_position.market_role == MarketRole.BUYER


# --------------------------------------------------
# TEST 9 — Reject negative electricity quantities
# --------------------------------------------------

@pytest.mark.parametrize(
    "production,consumption",
    [
        (-1, 1000),
        (1000, -1),
    ],
)
def test_rejects_negative_quantities(
    production,
    consumption,
):

    quantities = EnergyQuantities(
        production_wh=production,
        consumption_wh=consumption,
    )

    with pytest.raises(
        ValueError,
        match="cannot be negative",
    ):
        classify_market_position(quantities)


# --------------------------------------------------
# TEST 10 — Reject non-integer quantities
# --------------------------------------------------

@pytest.mark.parametrize(
    "production,consumption",
    [
        (1000.5, 500),
        ("1000", 500),
        (True, 500),
        (1000, False),
    ],
)
def test_rejects_non_integer_quantities(
    production,
    consumption,
):

    quantities = EnergyQuantities(
        production_wh=production,
        consumption_wh=consumption,
    )

    with pytest.raises(
        TypeError,
        match="must be an integer",
    ):
        classify_market_position(quantities)


# --------------------------------------------------
# TEST 11 — Reject unsupported input objects
# --------------------------------------------------

def test_rejects_invalid_input_object():

    with pytest.raises(
        TypeError,
        match="EnergyQuantities",
    ):
        classify_market_position({
            "production_wh": 1000,
            "consumption_wh": 500,
        })


# --------------------------------------------------
# TEST 12 — MarketPosition is immutable
# --------------------------------------------------

def test_market_position_is_immutable():

    position = classify_market_position(
        EnergyQuantities(
            production_wh=6000,
            consumption_wh=2000,
        )
    )

    assert isinstance(position, MarketPosition)

    with pytest.raises(FrozenInstanceError):
        position.available_energy_wh = 0


# --------------------------------------------------
# TEST 13 — Check energy conservation
# --------------------------------------------------

@pytest.mark.parametrize(
    "production,consumption",
    [
        (6000, 2000),
        (1000, 3000),
        (2000, 2000),
        (0, 500),
        (0, 0),
    ],
)
def test_market_quantities_are_consistent(
    production,
    consumption,
):

    position = classify_market_position(
        EnergyQuantities(
            production_wh=production,
            consumption_wh=consumption,
        )
    )

    assert (
        position.available_energy_wh
        - position.required_energy_wh
        == position.net_energy_wh
    )

    assert position.available_energy_wh >= 0
    assert position.required_energy_wh >= 0

    assert not (
        position.available_energy_wh > 0
        and position.required_energy_wh > 0
    )


# --------------------------------------------------
# TEST 14 — Classification does not modify inputs
# --------------------------------------------------

def test_classification_does_not_mutate_input():

    quantities = EnergyQuantities(
        production_wh=6000,
        consumption_wh=2000,
    )

    before = (
        quantities.production_wh,
        quantities.consumption_wh,
    )

    classify_market_position(quantities)

    after = (
        quantities.production_wh,
        quantities.consumption_wh,
    )

    assert before == after
