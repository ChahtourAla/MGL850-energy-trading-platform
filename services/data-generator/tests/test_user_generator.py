
"""
Tests for reproducible static user generation.
"""

import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator, FormatChecker
from pydantic import ValidationError
from referencing import Registry, Resource

from data_generator.registry import load_user_registry

from data_generator.user_generator import (
    RegistryGenerationConfig,
    generate_user_registry,
    load_generation_config,
    save_user_registry,
)


# --------------------------------------------------
# 1. Locate configuration and shared schemas
# --------------------------------------------------

SERVICE_DIR = Path(__file__).resolve().parents[1]
ROOT = Path(__file__).resolve().parents[3]

CONFIG_PATH = (
    SERVICE_DIR
    / "config"
    / "user-registry-config.json"
)

SCHEMA_DIR = ROOT / "packages" / "shared" / "schemas"


@pytest.fixture
def config():
    return load_generation_config(CONFIG_PATH)


# --------------------------------------------------
# TEST 1 — Load valid configuration
# --------------------------------------------------

def test_load_generation_config(config):

    assert config.user_count == 12
    assert config.seed == 2026
    assert config.map_width_km == 10.0
    assert config.map_height_km == 10.0


# --------------------------------------------------
# TEST 2 — Generate the requested number of users
# --------------------------------------------------

def test_generates_requested_number_of_users(config):

    registry = generate_user_registry(config)

    assert registry.schema_version == "1.0.0"
    assert len(registry.users) == 12

    user_ids = [
        user.user_id
        for user in registry.users
    ]

    assert len(user_ids) == len(set(user_ids))


# --------------------------------------------------
# TEST 3 — Same seed produces identical users
# --------------------------------------------------

def test_generation_is_reproducible(config):

    first = generate_user_registry(config)
    second = generate_user_registry(config)

    assert first.model_dump(
        mode="json",
        by_alias=True,
        exclude_none=True,
    ) == second.model_dump(
        mode="json",
        by_alias=True,
        exclude_none=True,
    )


# --------------------------------------------------
# TEST 4 — Different seeds change the generated data
# --------------------------------------------------

def test_different_seeds_change_users(config):

    first = generate_user_registry(config)

    other_config = config.model_copy(
        update={"seed": config.seed + 1}
    )

    second = generate_user_registry(other_config)

    assert (
        first.users[0].user_id
        != second.users[0].user_id
    )


# --------------------------------------------------
# TEST 5 — Coordinates and reputation follow ranges
# --------------------------------------------------

def test_generated_profiles_respect_ranges(config):

    registry = generate_user_registry(config)

    allowed_preferences = set(
        config.energy_preferences
    )

    for user in registry.users:

        assert 0 <= user.x_km <= config.map_width_km
        assert 0 <= user.y_km <= config.map_height_km

        assert (
            config.minimum_reputation
            <= user.reputation
            <= config.maximum_reputation
        )

        assert (
            user.preferred_energy_type
            in allowed_preferences
        )

        assert user.name
        assert user.physical_address
        assert str(user.email).endswith("@example.com")


# --------------------------------------------------
# TEST 6 — The generator never creates wallets
# --------------------------------------------------

def test_generated_users_have_no_wallets(config):

    registry = generate_user_registry(config)

    for user in registry.users:

        assert user.hedera_account_id is None
        assert user.evm_address is None


# --------------------------------------------------
# TEST 7 — Output matches the shared JSON Schema
# --------------------------------------------------

def test_generated_registry_matches_json_schema(config):

    registry = generate_user_registry(config)

    data = registry.model_dump(
        mode="json",
        by_alias=True,
        exclude_none=True,
    )

    local_registry = Registry()

    for filename in [
        "common.schema.json",
        "user.schema.json",
        "user-registry.schema.json",
    ]:

        schema = json.loads(
            (SCHEMA_DIR / filename).read_text(
                encoding="utf-8"
            )
        )

        local_registry = local_registry.with_resource(
            schema["$id"],
            Resource.from_contents(schema),
        )

    registry_schema = json.loads(
        (
            SCHEMA_DIR / "user-registry.schema.json"
        ).read_text(encoding="utf-8")
    )

    validator = Draft202012Validator(
        registry_schema,
        registry=local_registry,
        format_checker=FormatChecker(),
    )

    validator.validate(data)


# --------------------------------------------------
# TEST 8 — Save and reload generated JSON
# --------------------------------------------------

def test_save_and_reload_registry(config, tmp_path):

    generated = generate_user_registry(config)

    output_path = (
        tmp_path
        / "generated"
        / "users.json"
    )

    saved_path = save_user_registry(
        generated,
        output_path,
    )

    assert saved_path.is_file()

    loaded = load_user_registry(saved_path)

    assert loaded.model_dump(
        mode="json",
        by_alias=True,
        exclude_none=True,
    ) == generated.model_dump(
        mode="json",
        by_alias=True,
        exclude_none=True,
    )


# --------------------------------------------------
# TEST 9 — Do not overwrite existing registries
# --------------------------------------------------

def test_prevents_accidental_overwriting(config, tmp_path):

    registry = generate_user_registry(config)
    output_path = tmp_path / "users.json"

    save_user_registry(registry, output_path)

    with pytest.raises(
        FileExistsError,
        match="Registry already exists",
    ):
        save_user_registry(registry, output_path)

    # An explicit overwrite must still work.
    save_user_registry(
        registry,
        output_path,
        overwrite=True,
    )


# --------------------------------------------------
# TEST 10 — Reject invalid configuration values
# --------------------------------------------------

@pytest.mark.parametrize(
    "field,value",
    [
        ("userCount", 0),
        ("userCount", 10001),
        ("seed", -1),
        ("mapWidthKm", 0),
        ("mapHeightKm", -1),
        ("minimumReputation", -1),
        ("energyPreferences", []),
        ("energyPreferences", ["NUCLEAR"]),
    ],
)
def test_rejects_invalid_config_values(
    field,
    value,
):

    raw = json.loads(
        CONFIG_PATH.read_text(encoding="utf-8")
    )

    raw[field] = value

    with pytest.raises(ValidationError):
        RegistryGenerationConfig.model_validate(raw)


# --------------------------------------------------
# TEST 11 — Reject an impossible reputation range
# --------------------------------------------------

def test_rejects_inverted_reputation_range():

    raw = json.loads(
        CONFIG_PATH.read_text(encoding="utf-8")
    )

    raw["minimumReputation"] = 90
    raw["maximumReputation"] = 50

    with pytest.raises(
        ValidationError,
        match="minimumReputation cannot exceed",
    ):
        RegistryGenerationConfig.model_validate(raw)


# --------------------------------------------------
# TEST 12 — Reject a missing configuration file
# --------------------------------------------------

def test_rejects_missing_config(tmp_path):

    missing = tmp_path / "missing.json"

    with pytest.raises(
        FileNotFoundError,
        match="Generation configuration not found",
    ):
        load_generation_config(missing)


# --------------------------------------------------
# TEST 13 — Reject malformed configuration JSON
# --------------------------------------------------

def test_rejects_malformed_config(tmp_path):

    path = tmp_path / "invalid.json"

    path.write_text(
        "{ invalid JSON }",
        encoding="utf-8",
    )

    with pytest.raises(
        ValueError,
        match="Invalid generation configuration",
    ):
        load_generation_config(path)
