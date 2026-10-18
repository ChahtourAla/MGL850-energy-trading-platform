
"""
Tests for deterministic hourly electricity simulation.
"""

import math
from pathlib import Path

import pytest
from pydantic import ValidationError

from p2p_energy_shared import (
    EnergyType,
    UserRegistry,
)

from data_generator.energy_config import (
    load_energy_config,
)

from data_generator.energy_simulator import (
    calculate_hourly_production_wh,
    calculate_hourly_consumption_wh,
    simulate_hourly_quantities,
)


# --------------------------------------------------
# 1. Locate configuration and example users
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
    registry = UserRegistry.model_validate_json(
        REGISTRY_PATH.read_text(encoding="utf-8")
    )

    return registry.users[0]


# --------------------------------------------------
# TEST 1 — Solar production must be zero at night
# --------------------------------------------------

@pytest.mark.parametrize(
    "hour",
    [0, 3, 20, 23],
)
def test_solar_production_zero_at_night(
    user,
    config,
    hour,
):
    time_slot = (
        f"2026-10-18T{hour:02d}:00:00Z"
    )

    production = calculate_hourly_production_wh(
        user=user,
        time_slot=time_slot,
        config=config,
        energy_type=EnergyType.SOLAR,
    )

    assert production == 0


# --------------------------------------------------
# TEST 2 — Solar production is positive at midday
# --------------------------------------------------

def test_solar_production_at_midday(user, config):

    production = calculate_hourly_production_wh(
        user=user,
        time_slot="2026-10-18T12:00:00Z",
        config=config,
        energy_type=EnergyType.SOLAR,
    )

    assert production > 0
    assert isinstance(production, int)


# --------------------------------------------------
# TEST 3 — Non-solar technologies produce energy
# --------------------------------------------------

@pytest.mark.parametrize(
    "energy_type",
    [
        EnergyType.WIND,
        EnergyType.HYDRO,
        EnergyType.GRID,
        EnergyType.MIXED,
    ],
)
def test_non_solar_production(
    user,
    config,
    energy_type,
):
    no_variation = config.model_copy(
        update={
            "production_variation_fraction": 0.0
        }
    )

    production = calculate_hourly_production_wh(
        user=user,
        time_slot="2026-10-18T12:00:00Z",
        config=no_variation,
        energy_type=energy_type,
    )

    assert (
        production
        == config.base_non_solar_production_wh
    )


# --------------------------------------------------
# TEST 4 — No production technology means zero
# --------------------------------------------------

def test_consumption_only_household(user, config):

    production = calculate_hourly_production_wh(
        user=user,
        time_slot="2026-10-18T12:00:00Z",
        config=config,
        energy_type=None,
    )

    assert production == 0


# --------------------------------------------------
# TEST 5 — Evening consumption exceeds midday
# --------------------------------------------------

def test_evening_consumption_peak(user, config):

    no_variation = config.model_copy(
        update={
            "consumption_variation_fraction": 0.0
        }
    )

    midday = calculate_hourly_consumption_wh(
        user=user,
        time_slot="2026-10-18T12:00:00Z",
        config=no_variation,
    )

    evening = calculate_hourly_consumption_wh(
        user=user,
        time_slot="2026-10-18T18:00:00Z",
        config=no_variation,
    )

    assert evening > midday


# --------------------------------------------------
# TEST 6 — Same inputs give identical outputs
# --------------------------------------------------

def test_simulation_is_deterministic(user, config):

    arguments = {
        "user": user,
        "time_slot": "2026-10-18T12:00:00Z",
        "config": config,
        "energy_type": EnergyType.SOLAR,
    }

    first = simulate_hourly_quantities(**arguments)
    second = simulate_hourly_quantities(**arguments)

    assert first == second


# --------------------------------------------------
# TEST 7 — Call order must not change results
# --------------------------------------------------

def test_simulation_is_order_independent(user, config):

    first = simulate_hourly_quantities(
        user,
        "2026-10-18T12:00:00Z",
        config,
        EnergyType.SOLAR,
    )

    # Simulate another hour between repeated calls.
    simulate_hourly_quantities(
        user,
        "2026-10-18T18:00:00Z",
        config,
        EnergyType.WIND,
    )

    repeated = simulate_hourly_quantities(
        user,
        "2026-10-18T12:00:00Z",
        config,
        EnergyType.SOLAR,
    )

    assert first == repeated


# --------------------------------------------------
# TEST 8 — Quantities must be valid integers
# --------------------------------------------------

def test_energy_quantities_and_net_energy(user, config):

    result = simulate_hourly_quantities(
        user,
        "2026-10-18T12:00:00Z",
        config,
        EnergyType.SOLAR,
    )

    assert isinstance(result.production_wh, int)
    assert isinstance(result.consumption_wh, int)

    assert result.production_wh >= 0
    assert result.consumption_wh >= 0

    assert result.net_energy_wh == (
        result.production_wh - result.consumption_wh
    )


# --------------------------------------------------
# TEST 9 — Zero variation gives exact values
# --------------------------------------------------

def test_zero_variation_produces_expected_values(
    user,
    config,
):
    no_variation = config.model_copy(
        update={
            "production_variation_fraction": 0.0,
            "consumption_variation_fraction": 0.0,
        }
    )

    result = simulate_hourly_quantities(
        user,
        "2026-10-18T12:00:00Z",
        no_variation,
        EnergyType.SOLAR,
    )

    assert result.production_wh == 6500
    assert result.consumption_wh == 2125
    assert result.net_energy_wh == 4375


# --------------------------------------------------
# TEST 10 — Variation stays inside configured limits
# --------------------------------------------------

def test_variation_stays_within_limits(user, config):

    result = simulate_hourly_quantities(
        user,
        "2026-10-18T12:00:00Z",
        config,
        EnergyType.SOLAR,
    )

    base_production = (
        config.peak_solar_production_wh
        * config.solar_production_profile[12]
    )

    base_consumption = (
        config.base_consumption_wh
        * config.consumption_profile[12]
    )

    assert (
        math.floor(
            base_production
            * (1 - config.production_variation_fraction)
        )
        <= result.production_wh
        <= math.ceil(
            base_production
            * (1 + config.production_variation_fraction)
        )
    )

    assert (
        math.floor(
            base_consumption
            * (1 - config.consumption_variation_fraction)
        )
        <= result.consumption_wh
        <= math.ceil(
            base_consumption
            * (1 + config.consumption_variation_fraction)
        )
    )


# --------------------------------------------------
# TEST 11 — Wallets are not required
# --------------------------------------------------

def test_simulation_does_not_require_wallet(user, config):

    assert user.evm_address is None
    assert user.hedera_account_id is None

    result = simulate_hourly_quantities(
        user,
        "2026-10-18T12:00:00Z",
        config,
        EnergyType.SOLAR,
    )

    assert result.production_wh >= 0
    assert result.consumption_wh >= 0


# --------------------------------------------------
# TEST 12 — Changing the seed changes simulation
# --------------------------------------------------

def test_changing_seed_changes_results(user, config):

    different_config = config.model_copy(
        update={"seed": config.seed + 1}
    )

    hours = [9, 12, 13, 17]

    original = [
        simulate_hourly_quantities(
            user,
            f"2026-10-18T{hour:02d}:00:00Z",
            config,
            EnergyType.SOLAR,
        )
        for hour in hours
    ]

    changed = [
        simulate_hourly_quantities(
            user,
            f"2026-10-18T{hour:02d}:00:00Z",
            different_config,
            EnergyType.SOLAR,
        )
        for hour in hours
    ]

    assert original != changed


# --------------------------------------------------
# TEST 13 — Reject invalid hourly timestamps
# --------------------------------------------------

@pytest.mark.parametrize(
    "time_slot",
    [
        "2026-10-18T12:30:00Z",
        "2026-02-30T12:00:00Z",
        "2026-10-18T12:00:00+00:00",
    ],
)
def test_rejects_invalid_time_slots(
    user,
    config,
    time_slot,
):
    with pytest.raises(ValidationError):
        simulate_hourly_quantities(
            user,
            time_slot,
            config,
            EnergyType.SOLAR,
        )


# --------------------------------------------------
# TEST 14 — Reject unsupported production types
# --------------------------------------------------

@pytest.mark.parametrize(
    "energy_type",
    ["SOLAR", "NUCLEAR"],
)
def test_rejects_invalid_energy_type(
    user,
    config,
    energy_type,
):
    with pytest.raises(TypeError):
        simulate_hourly_quantities(
            user,
            "2026-10-18T12:00:00Z",
            config,
            energy_type,
        )


# --------------------------------------------------
# TEST 15 — Do not modify user/configuration
# --------------------------------------------------

def test_simulation_does_not_mutate_inputs(
    user,
    config,
):
    original_user = user.model_dump()
    original_config = config.model_dump()

    simulate_hourly_quantities(
        user,
        "2026-10-18T12:00:00Z",
        config,
        EnergyType.SOLAR,
    )

    assert user.model_dump() == original_user
    assert config.model_dump() == original_config


# --------------------------------------------------
# TEST 16 — Consumption is independent of source
# --------------------------------------------------

def test_consumption_does_not_depend_on_source(
    user,
    config,
):
    solar = simulate_hourly_quantities(
        user,
        "2026-10-18T12:00:00Z",
        config,
        EnergyType.SOLAR,
    )

    without_production = simulate_hourly_quantities(
        user,
        "2026-10-18T12:00:00Z",
        config,
        None,
    )

    assert (
        solar.consumption_wh
        == without_production.consumption_wh
    )
