
"""
Tests for hourly energy simulation configuration.
"""

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from data_generator import __version__
from data_generator.energy_config import (
    EnergyGenerationConfig,
    load_energy_config,
)


# --------------------------------------------------
# 1. Locate our configuration file
# --------------------------------------------------

SERVICE_DIR = Path(__file__).resolve().parents[1]

CONFIG_PATH = (
    SERVICE_DIR
    / "config"
    / "energy-generation-config.json"
)


@pytest.fixture
def raw_config():
    return json.loads(
        CONFIG_PATH.read_text(encoding="utf-8")
    )


# --------------------------------------------------
# TEST 1 — Load valid configuration
# --------------------------------------------------

def test_load_energy_config():

    config = load_energy_config(CONFIG_PATH)

    assert config.seed == 2026
    assert config.base_consumption_wh == 2500
    assert config.peak_solar_production_wh == 6500
    assert config.base_non_solar_production_wh == 2200
    assert config.generator_version == __version__


# --------------------------------------------------
# TEST 2 — JSON serialization
# --------------------------------------------------

def test_config_round_trip(raw_config):

    config = EnergyGenerationConfig.model_validate(
        raw_config
    )

    exported = config.model_dump(
        mode="json",
        by_alias=True,
    )

    assert exported == raw_config


# --------------------------------------------------
# TEST 3 — Validate daily profile structure
# --------------------------------------------------

def test_daily_profiles():

    config = load_energy_config(CONFIG_PATH)

    assert len(config.solar_production_profile) == 24
    assert len(config.consumption_profile) == 24

    # Solar production is zero during the night.
    assert config.solar_production_profile[0] == 0
    assert config.solar_production_profile[23] == 0

    # Solar production peaks around midday.
    assert config.solar_production_profile[12] == 1.0

    # Evening demand exceeds midday demand.
    assert (
        config.consumption_profile[18]
        > config.consumption_profile[12]
    )


# --------------------------------------------------
# TEST 4 — Price ranges allow trading
# --------------------------------------------------

def test_price_ranges_overlap():

    config = load_energy_config(CONFIG_PATH)

    assert (
        config.seller_ask_price_range.minimum
        <= config.buyer_max_price_range.maximum
    )

    assert (
        config.seller_ask_price_range.maximum
        >= config.buyer_max_price_range.minimum
    )


# --------------------------------------------------
# TEST 5 — Reject invalid scalar settings
# --------------------------------------------------

@pytest.mark.parametrize(
    "field,value",
    [
        ("seed", -1),
        ("seed", "2026"),
        ("baseConsumptionWh", 0),
        ("peakSolarProductionWh", 0),
        ("baseNonSolarProductionWh", -1),
        ("productionVariationFraction", -0.1),
        ("productionVariationFraction", 0.7),
        ("consumptionVariationFraction", 0.7),
        ("generatorVersion", "v1"),
        ("schemaVersion", "1.0"),
    ],
)
def test_rejects_invalid_scalar_field(
    raw_config,
    field,
    value,
):

    raw_config[field] = value

    with pytest.raises(ValidationError):
        EnergyGenerationConfig.model_validate(
            raw_config
        )


# --------------------------------------------------
# TEST 6 — Reject invalid hourly profiles
# --------------------------------------------------

@pytest.mark.parametrize(
    "field,profile",
    [
        ("solarProductionProfile", [0.0] * 23),
        ("solarProductionProfile", [0.0] * 25),
        ("solarProductionProfile", [0.0] * 23 + [-0.1]),
        ("solarProductionProfile", [0.0] * 23 + [1.1]),
        ("consumptionProfile", [0.5] * 23),
        ("consumptionProfile", [0.5] * 23 + [-0.1]),
        ("consumptionProfile", [0.5] * 23 + [2.5]),
    ],
)
def test_rejects_invalid_hourly_profile(
    raw_config,
    field,
    profile,
):

    raw_config[field] = profile

    with pytest.raises(ValidationError):
        EnergyGenerationConfig.model_validate(
            raw_config
        )


# --------------------------------------------------
# TEST 7 — Reject invalid energy type weights
# --------------------------------------------------

@pytest.mark.parametrize(
    "energy_type,value",
    [
        ("SOLAR", 0.70),
        ("WIND", -0.10),
        ("NUCLEAR", 0.10),
    ],
)
def test_rejects_invalid_energy_type_weights(
    raw_config,
    energy_type,
    value,
):

    raw_config["productionEnergyTypeWeights"][
        energy_type
    ] = value

    with pytest.raises(ValidationError):
        EnergyGenerationConfig.model_validate(
            raw_config
        )


# --------------------------------------------------
# TEST 8 — Reject invalid pricing configurations
# --------------------------------------------------

@pytest.mark.parametrize(
    "case",
    [
        "zero-seller-minimum",
        "inverted-seller-range",
        "no-price-overlap",
    ],
)
def test_rejects_invalid_prices(
    raw_config,
    case,
):

    if case == "zero-seller-minimum":
        raw_config["sellerAskPriceRange"][
            "minMicrousdPerKwh"
        ] = 0

    elif case == "inverted-seller-range":
        raw_config["sellerAskPriceRange"][
            "minMicrousdPerKwh"
        ] = 200000

    elif case == "no-price-overlap":
        raw_config["buyerMaxPriceRange"][
            "minMicrousdPerKwh"
        ] = 50000

        raw_config["buyerMaxPriceRange"][
            "maxMicrousdPerKwh"
        ] = 70000

    with pytest.raises(ValidationError):
        EnergyGenerationConfig.model_validate(
            raw_config
        )


# --------------------------------------------------
# TEST 9 — Reject missing configuration file
# --------------------------------------------------

def test_rejects_missing_config(tmp_path):

    missing = tmp_path / "missing.json"

    with pytest.raises(
        FileNotFoundError,
        match="Energy configuration not found",
    ):
        load_energy_config(missing)


# --------------------------------------------------
# TEST 10 — Reject malformed JSON
# --------------------------------------------------

def test_rejects_malformed_json(tmp_path):

    path = tmp_path / "invalid.json"

    path.write_text(
        "{ invalid JSON }",
        encoding="utf-8",
    )

    with pytest.raises(
        ValueError,
        match="Invalid energy configuration",
    ):
        load_energy_config(path)
