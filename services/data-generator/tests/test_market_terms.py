
"""
Tests for deterministic energy source assignment
and market price generation.
"""

from pathlib import Path

import pytest
from pydantic import ValidationError

from p2p_energy_shared import (
    EnergyType,
    PreferredEnergyType,
)

from data_generator.energy_config import (
    load_energy_config,
)

from data_generator.energy_simulator import (
    EnergyQuantities,
)

from data_generator.market_roles import (
    classify_market_position,
)

from data_generator.market_terms import (
    MarketTerms,
    assign_production_energy_type,
    generate_market_terms,
)

from data_generator.registry import (
    load_user_registry,
)


# --------------------------------------------------
# 1. Configuration and fixture paths
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

HOUR = "2026-10-18T12:00:00Z"


@pytest.fixture
def config():
    return load_energy_config(CONFIG_PATH)


@pytest.fixture
def user():
    return load_user_registry(REGISTRY_PATH).users[0]


def make_seller():
    return classify_market_position(
        EnergyQuantities(6000, 2000)
    )


def make_buyer():
    return classify_market_position(
        EnergyQuantities(1000, 3000)
    )


def make_neutral():
    return classify_market_position(
        EnergyQuantities(2000, 2000)
    )


# --------------------------------------------------
# TEST 1 — Assigned source is supported
# --------------------------------------------------

def test_assigns_valid_source(user, config):

    source = assign_production_energy_type(
        user, config
    )

    assert isinstance(source, EnergyType)


# --------------------------------------------------
# TEST 2 — Source assignment is reproducible
# --------------------------------------------------

def test_source_assignment_is_deterministic(
    user, config
):

    first = assign_production_energy_type(
        user, config
    )

    second = assign_production_energy_type(
        user, config
    )

    assert first == second


# --------------------------------------------------
# TEST 3 — Buying preference is independent
# --------------------------------------------------

def test_source_ignores_buying_preference(
    user, config
):

    changed_user = user.model_copy(
        update={
            "preferred_energy_type":
                PreferredEnergyType.WIND
        }
    )

    assert assign_production_energy_type(
        user, config
    ) == assign_production_energy_type(
        changed_user, config
    )


# --------------------------------------------------
# TEST 4 — Respect configured source weights
# --------------------------------------------------

def test_source_respects_weights(user, config):

    # Make WIND the only possible technology.
    forced_weights = (
        config.production_energy_type_weights.model_copy(
            update={
                "solar": 0.0,
                "wind": 1.0,
                "hydro": 0.0,
                "grid": 0.0,
                "mixed": 0.0,
            }
        )
    )

    forced_config = config.model_copy(
        update={
            "production_energy_type_weights":
                forced_weights
        }
    )

    source = assign_production_energy_type(
        user, forced_config
    )

    assert source == EnergyType.WIND


# --------------------------------------------------
# TEST 5 — Support consumption-only households
# --------------------------------------------------

def test_household_without_local_generation(
    user, config
):

    source = assign_production_energy_type(
        user,
        config,
        has_local_generation=False,
    )

    assert source is None


# --------------------------------------------------
# TEST 6 — Reject invalid generation flags
# --------------------------------------------------

@pytest.mark.parametrize(
    "invalid_flag",
    [1, "yes"],
)
def test_rejects_invalid_generation_flag(
    user, config, invalid_flag
):

    with pytest.raises(TypeError):
        assign_production_energy_type(
            user,
            config,
            has_local_generation=invalid_flag,
        )


# --------------------------------------------------
# TEST 7 — Correct SELLER terms
# --------------------------------------------------

def test_generates_seller_terms(user, config):

    terms = generate_market_terms(
        user=user,
        time_slot=HOUR,
        config=config,
        position=make_seller(),
        production_energy_type=EnergyType.SOLAR,
    )

    assert isinstance(terms, MarketTerms)
    assert terms.energy_type == EnergyType.SOLAR

    assert terms.ask_price_microusd_per_kwh is not None
    assert terms.max_price_microusd_per_kwh is None

    assert (
        config.seller_ask_price_range.minimum
        <= terms.ask_price_microusd_per_kwh
        <= config.seller_ask_price_range.maximum
    )


# --------------------------------------------------
# TEST 8 — Correct BUYER terms
# --------------------------------------------------

def test_generates_buyer_terms(user, config):

    terms = generate_market_terms(
        user=user,
        time_slot=HOUR,
        config=config,
        position=make_buyer(),
        production_energy_type=EnergyType.SOLAR,
    )

    assert terms.energy_type is None
    assert terms.ask_price_microusd_per_kwh is None

    assert terms.max_price_microusd_per_kwh is not None

    assert (
        config.buyer_max_price_range.minimum
        <= terms.max_price_microusd_per_kwh
        <= config.buyer_max_price_range.maximum
    )


# --------------------------------------------------
# TEST 9 — NEUTRAL has no market offer
# --------------------------------------------------

def test_generates_neutral_terms(user, config):

    terms = generate_market_terms(
        user,
        HOUR,
        config,
        make_neutral(),
        EnergyType.SOLAR,
    )

    assert terms.energy_type is None
    assert terms.ask_price_microusd_per_kwh is None
    assert terms.max_price_microusd_per_kwh is None


# --------------------------------------------------
# TEST 10 — Prices are reproducible
# --------------------------------------------------

def test_prices_are_deterministic(user, config):

    first = generate_market_terms(
        user, HOUR, config,
        make_seller(), EnergyType.SOLAR,
    )

    second = generate_market_terms(
        user, HOUR, config,
        make_seller(), EnergyType.SOLAR,
    )

    assert first == second


# --------------------------------------------------
# TEST 11 — Call order does not affect prices
# --------------------------------------------------

def test_prices_are_order_independent(user, config):

    first = generate_market_terms(
        user, HOUR, config,
        make_seller(), EnergyType.SOLAR,
    )

    generate_market_terms(
        user,
        "2026-10-18T18:00:00Z",
        config,
        make_buyer(),
        EnergyType.SOLAR,
    )

    repeated = generate_market_terms(
        user, HOUR, config,
        make_seller(), EnergyType.SOLAR,
    )

    assert first == repeated


# --------------------------------------------------
# TEST 12 — A changed seed changes price sequences
# --------------------------------------------------

def test_seed_changes_price_sequence(user, config):

    other_config = config.model_copy(
        update={"seed": config.seed + 1}
    )

    hours = [9, 10, 11, 12, 13]

    def prices_for(configuration):
        return [
            generate_market_terms(
                user,
                f"2026-10-18T{hour:02d}:00:00Z",
                configuration,
                make_seller(),
                EnergyType.SOLAR,
            ).ask_price_microusd_per_kwh
            for hour in hours
        ]

    assert prices_for(config) != prices_for(other_config)


# --------------------------------------------------
# TEST 13 — Prices stay inside their ranges
# --------------------------------------------------

@pytest.mark.parametrize(
    "market_role",
    ["seller", "buyer"],
)
def test_prices_stay_in_range(
    user, config, market_role
):

    position = (
        make_seller()
        if market_role == "seller"
        else make_buyer()
    )

    for hour in range(24):

        terms = generate_market_terms(
            user,
            f"2026-10-18T{hour:02d}:00:00Z",
            config,
            position,
            EnergyType.SOLAR,
        )

        if market_role == "seller":
            price = terms.ask_price_microusd_per_kwh
            allowed = config.seller_ask_price_range

        else:
            price = terms.max_price_microusd_per_kwh
            allowed = config.buyer_max_price_range

        assert allowed.minimum <= price <= allowed.maximum


# --------------------------------------------------
# TEST 14 — Fixed price ranges are respected
# --------------------------------------------------

@pytest.mark.parametrize(
    "market_role",
    ["seller", "buyer"],
)
def test_fixed_price_ranges(
    user, config, market_role
):

    seller_range = config.seller_ask_price_range.model_copy(
        update={
            "minimum": 140000,
            "maximum": 140000,
        }
    )

    buyer_range = config.buyer_max_price_range.model_copy(
        update={
            "minimum": 170000,
            "maximum": 170000,
        }
    )

    fixed_config = config.model_copy(
        update={
            "seller_ask_price_range": seller_range,
            "buyer_max_price_range": buyer_range,
        }
    )

    position = (
        make_seller()
        if market_role == "seller"
        else make_buyer()
    )

    terms = generate_market_terms(
        user, HOUR, fixed_config,
        position, EnergyType.SOLAR,
    )

    if market_role == "seller":
        assert terms.ask_price_microusd_per_kwh == 140000
    else:
        assert terms.max_price_microusd_per_kwh == 170000


# --------------------------------------------------
# TEST 15 — A SELLER requires a source
# --------------------------------------------------

def test_seller_requires_energy_source(user, config):

    with pytest.raises(
        ValueError,
        match="must have a production",
    ):
        generate_market_terms(
            user,
            HOUR,
            config,
            make_seller(),
            None,
        )


# --------------------------------------------------
# TEST 16 — Reject invalid source types
# --------------------------------------------------

@pytest.mark.parametrize(
    "invalid_source",
    ["SOLAR", "NUCLEAR"],
)
def test_rejects_invalid_energy_source(
    user, config, invalid_source
):

    with pytest.raises(TypeError):
        generate_market_terms(
            user,
            HOUR,
            config,
            make_seller(),
            invalid_source,
        )


# --------------------------------------------------
# TEST 17 — Reject invalid time slots
# --------------------------------------------------

@pytest.mark.parametrize(
    "time_slot",
    [
        "2026-10-18T12:30:00Z",
        "2026-02-30T12:00:00Z",
        "2026-10-18T12:00:00+00:00",
    ],
)
def test_rejects_invalid_time_slot(
    user, config, time_slot
):

    with pytest.raises(ValidationError):
        generate_market_terms(
            user,
            time_slot,
            config,
            make_buyer(),
            None,
        )


# --------------------------------------------------
# TEST 18 — Reject unsupported position objects
# --------------------------------------------------

def test_rejects_invalid_position(user, config):

    with pytest.raises(TypeError):
        generate_market_terms(
            user,
            HOUR,
            config,
            "SELLER",
            EnergyType.SOLAR,
        )


# --------------------------------------------------
# TEST 19 — Do not modify inputs
# --------------------------------------------------

def test_does_not_modify_inputs(user, config):

    original_user = user.model_dump()
    original_config = config.model_dump()

    position = make_seller()

    generate_market_terms(
        user,
        HOUR,
        config,
        position,
        EnergyType.SOLAR,
    )

    assert user.model_dump() == original_user
    assert config.model_dump() == original_config
    assert position == make_seller()


# --------------------------------------------------
# TEST 20 — Buyer pricing ignores installed source
# --------------------------------------------------

def test_buyer_price_independent_of_source(
    user, config
):

    with_solar = generate_market_terms(
        user, HOUR, config,
        make_buyer(), EnergyType.SOLAR,
    )

    without_generation = generate_market_terms(
        user, HOUR, config,
        make_buyer(), None,
    )

    assert with_solar == without_generation
