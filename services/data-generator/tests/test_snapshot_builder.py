
"""
Integration tests for complete hourly EnergySnapshots.
"""

import json
from copy import deepcopy
from pathlib import Path
from uuid import uuid4

import pytest
from jsonschema import Draft202012Validator, FormatChecker
from pydantic import ValidationError
from referencing import Registry, Resource

from p2p_energy_shared import (
    EnergySnapshot,
    MarketRole,
    MatchingConfig,
    MatchingInput,
    UserRegistry,
)

from data_generator.energy_config import load_energy_config
from data_generator.energy_simulator import (
    simulate_hourly_quantities,
)
from data_generator.market_roles import (
    classify_market_position,
)
from data_generator.market_terms import (
    assign_production_energy_type,
    generate_market_terms,
)
from data_generator.snapshot_builder import (
    build_energy_snapshot,
)


# --------------------------------------------------
# 1. Shared paths and test fixtures
# --------------------------------------------------

ROOT = Path(__file__).resolve().parents[3]
FIXTURES = ROOT / "packages" / "shared" / "fixtures"
SCHEMAS = ROOT / "packages" / "shared" / "schemas"

CONFIG_PATH = (
    ROOT
    / "services"
    / "data-generator"
    / "config"
    / "energy-generation-config.json"
)

HOUR = "2026-10-18T12:00:00Z"


def load_json(path):
    return json.loads(
        path.read_text(encoding="utf-8")
    )


@pytest.fixture
def config():
    return load_energy_config(CONFIG_PATH)


@pytest.fixture
def registry():
    """
    Enrich our existing users with dummy wallet IDs.
    No real blockchain accounts are created.
    """
    data = load_json(
        FIXTURES / "user-registry.sample.json"
    )

    for index, user in enumerate(
        data["users"],
        start=1,
    ):
        user["hederaAccountId"] = f"0.0.{10000 + index}"
        user["evmAddress"] = f"0x{index:040x}"

    return UserRegistry.model_validate(data)


# --------------------------------------------------
# TEST 1 — Exactly one record per registered user
# --------------------------------------------------

def test_one_record_per_user(registry, config):

    snapshot = build_energy_snapshot(
        registry, HOUR, config
    )

    assert isinstance(snapshot, EnergySnapshot)
    assert len(snapshot.users) == len(registry.users)

    expected_ids = {
        user.user_id for user in registry.users
    }

    actual_ids = {
        record.user_id for record in snapshot.users
    }

    assert actual_ids == expected_ids

    assert len({
        record.record_id for record in snapshot.users
    }) == len(snapshot.users)


# --------------------------------------------------
# TEST 2 — Use the existing simulation components
# --------------------------------------------------

def test_records_match_simulation(registry, config):

    snapshot = build_energy_snapshot(
        registry, HOUR, config
    )

    records = {
        record.user_id: record
        for record in snapshot.users
    }

    for user in registry.users:

        source = assign_production_energy_type(
            user, config
        )

        quantities = simulate_hourly_quantities(
            user, HOUR, config, source
        )

        position = classify_market_position(
            quantities
        )

        terms = generate_market_terms(
            user, HOUR, config, position, source
        )

        record = records[user.user_id]

        assert record.production_wh == quantities.production_wh
        assert record.consumption_wh == quantities.consumption_wh
        assert record.net_energy_wh == position.net_energy_wh

        assert record.market_role == position.market_role
        assert record.available_energy_wh == position.available_energy_wh
        assert record.required_energy_wh == position.required_energy_wh

        assert record.energy_type == terms.energy_type
        assert (
            record.ask_price_microusd_per_kwh
            == terms.ask_price_microusd_per_kwh
        )
        assert (
            record.max_price_microusd_per_kwh
            == terms.max_price_microusd_per_kwh
        )

        assert record.evm_address == user.evm_address


# --------------------------------------------------
# TEST 3 — Correct fields for each market role
# --------------------------------------------------

def test_market_role_fields(registry, config):

    snapshot = build_energy_snapshot(
        registry, HOUR, config
    )

    for record in snapshot.users:

        if record.market_role == MarketRole.SELLER:
            assert record.available_energy_wh > 0
            assert record.energy_type is not None
            assert record.ask_price_microusd_per_kwh is not None
            assert record.max_price_microusd_per_kwh is None

        elif record.market_role == MarketRole.BUYER:
            assert record.required_energy_wh > 0
            assert record.energy_type is None
            assert record.ask_price_microusd_per_kwh is None
            assert record.max_price_microusd_per_kwh is not None

        else:
            assert record.available_energy_wh == 0
            assert record.required_energy_wh == 0
            assert record.energy_type is None
            assert record.ask_price_microusd_per_kwh is None
            assert record.max_price_microusd_per_kwh is None


# --------------------------------------------------
# TEST 4 — Output follows our existing JSON Schema
# --------------------------------------------------

def test_snapshot_matches_json_schema(registry, config):

    snapshot = build_energy_snapshot(
        registry, HOUR, config
    )

    exported = snapshot.model_dump(
        mode="json",
        by_alias=True,
    )

    local_registry = Registry()

    for path in sorted(
        SCHEMAS.glob("*.schema.json")
    ):
        schema = load_json(path)

        local_registry = local_registry.with_resource(
            schema["$id"],
            Resource.from_contents(schema),
        )

    snapshot_schema = load_json(
        SCHEMAS / "energy-snapshot.schema.json"
    )

    validator = Draft202012Validator(
        snapshot_schema,
        registry=local_registry,
        format_checker=FormatChecker(),
    )

    validator.validate(exported)


# --------------------------------------------------
# TEST 5 — Identical inputs yield identical snapshots
# --------------------------------------------------

def test_snapshot_is_reproducible(registry, config):

    first = build_energy_snapshot(
        registry, HOUR, config
    )

    second = build_energy_snapshot(
        registry, HOUR, config
    )

    assert first.model_dump_json(
        by_alias=True
    ) == second.model_dump_json(
        by_alias=True
    )


# --------------------------------------------------
# TEST 6 — Registry order does not change output
# --------------------------------------------------

def test_registry_order_is_independent(registry, config):

    reversed_registry = UserRegistry(
        schemaVersion=registry.schema_version,
        users=list(reversed(registry.users)),
    )

    first = build_energy_snapshot(
        registry, HOUR, config
    )

    second = build_energy_snapshot(
        reversed_registry, HOUR, config
    )

    assert first == second


# --------------------------------------------------
# TEST 7 — A different hour creates a new snapshot
# --------------------------------------------------

def test_different_hour_changes_snapshot(registry, config):

    first = build_energy_snapshot(
        registry, HOUR, config
    )

    second = build_energy_snapshot(
        registry,
        "2026-10-18T18:00:00Z",
        config,
    )

    assert first.snapshot_id != second.snapshot_id
    assert first.time_slot != second.time_slot


# --------------------------------------------------
# TEST 8 — A different seed changes snapshot ID
# --------------------------------------------------

def test_different_seed_changes_snapshot(registry, config):

    changed_config = config.model_copy(
        update={"seed": config.seed + 1}
    )

    first = build_energy_snapshot(
        registry, HOUR, config
    )

    second = build_energy_snapshot(
        registry, HOUR, changed_config
    )

    assert first.snapshot_id != second.snapshot_id


# --------------------------------------------------
# TEST 9 — Profile changes produce a new snapshot ID
# --------------------------------------------------

def test_profile_change_changes_id(registry, config):

    raw = registry.model_dump(
        mode="json",
        by_alias=True,
        exclude_none=True,
    )

    raw["users"][0]["reputation"] = 50

    changed_registry = UserRegistry.model_validate(
        raw
    )

    first = build_energy_snapshot(
        registry, HOUR, config
    )

    second = build_energy_snapshot(
        changed_registry, HOUR, config
    )

    assert first.snapshot_id != second.snapshot_id


# --------------------------------------------------
# TEST 10 — Support a consumption-only household
# --------------------------------------------------

def test_consumption_only_household(registry, config):

    user_id = registry.users[0].user_id

    snapshot = build_energy_snapshot(
        registry,
        HOUR,
        config,
        consumption_only_user_ids={user_id},
    )

    record = next(
        record for record in snapshot.users
        if record.user_id == user_id
    )

    assert record.production_wh == 0
    assert record.market_role == MarketRole.BUYER
    assert record.energy_type is None
    assert record.required_energy_wh > 0


# --------------------------------------------------
# TEST 11 — All households may lack generation
# --------------------------------------------------

def test_all_consumption_only(registry, config):

    consumer_ids = {
        user.user_id for user in registry.users
    }

    snapshot = build_energy_snapshot(
        registry,
        HOUR,
        config,
        consumption_only_user_ids=consumer_ids,
    )

    assert all(
        record.production_wh == 0
        for record in snapshot.users
    )

    assert all(
        record.market_role == MarketRole.BUYER
        for record in snapshot.users
    )


# --------------------------------------------------
# TEST 12 — Reject static registries without wallets
# --------------------------------------------------

def test_rejects_missing_wallets(config):

    raw = load_json(
        FIXTURES / "user-registry.sample.json"
    )

    registry = UserRegistry.model_validate(raw)

    with pytest.raises(
        ValueError,
        match="missing blockchain wallet",
    ):
        build_energy_snapshot(
            registry, HOUR, config
        )


# --------------------------------------------------
# TEST 13 — Reject duplicate EVM addresses
# --------------------------------------------------

def test_rejects_duplicate_evm_addresses(
    registry, config
):

    raw = registry.model_dump(
        mode="json",
        by_alias=True,
    )

    raw["users"][1]["evmAddress"] = (
        raw["users"][0]["evmAddress"]
    )

    duplicate_registry = UserRegistry.model_validate(
        raw
    )

    with pytest.raises(
        ValueError,
        match="Duplicate EVM address",
    ):
        build_energy_snapshot(
            duplicate_registry, HOUR, config
        )


# --------------------------------------------------
# TEST 14 — Reject duplicate Hedera accounts
# --------------------------------------------------

def test_rejects_duplicate_hedera_ids(registry, config):

    raw = registry.model_dump(
        mode="json",
        by_alias=True,
    )

    raw["users"][1]["hederaAccountId"] = (
        raw["users"][0]["hederaAccountId"]
    )

    duplicate_registry = UserRegistry.model_validate(
        raw
    )

    with pytest.raises(
        ValueError,
        match="Duplicate Hedera account ID",
    ):
        build_energy_snapshot(
            duplicate_registry, HOUR, config
        )


# --------------------------------------------------
# TEST 15 — Reject unknown consumption-only IDs
# --------------------------------------------------

def test_rejects_unknown_consumption_user(
    registry, config
):

    with pytest.raises(
        ValueError,
        match="Unknown consumption-only user IDs",
    ):
        build_energy_snapshot(
            registry,
            HOUR,
            config,
            consumption_only_user_ids={uuid4()},
        )


# --------------------------------------------------
# TEST 16 — Registry/config schema must match
# --------------------------------------------------

def test_rejects_schema_version_mismatch(
    registry, config
):

    changed_config = config.model_copy(
        update={"schema_version": "2.0.0"}
    )

    with pytest.raises(
        ValueError,
        match="schema versions differ",
    ):
        build_energy_snapshot(
            registry, HOUR, changed_config
        )


# --------------------------------------------------
# TEST 17 — Reject invalid hourly timestamps
# --------------------------------------------------

@pytest.mark.parametrize(
    "time_slot",
    [
        "2026-10-18T12:30:00Z",
        "2026-02-30T12:00:00Z",
        "2026-10-18T12:00:00+00:00",
    ],
)
def test_rejects_invalid_hour(
    registry, config, time_slot
):

    with pytest.raises(ValidationError):
        build_energy_snapshot(
            registry, time_slot, config
        )


# --------------------------------------------------
# TEST 18 — Reject wrong registry/config types
# --------------------------------------------------

@pytest.mark.parametrize(
    "incorrect_argument",
    ["registry", "config"],
)
def test_rejects_incorrect_arguments(
    registry, config, incorrect_argument
):

    if incorrect_argument == "registry":
        registry = {}

    else:
        config = {}

    with pytest.raises(TypeError):
        build_energy_snapshot(
            registry, HOUR, config
        )


# --------------------------------------------------
# TEST 19 — Validate consumption-only argument
# --------------------------------------------------

@pytest.mark.parametrize(
    "invalid_value",
    [
        ["not-a-uuid"],
        {"not-a-uuid"},
    ],
)
def test_rejects_invalid_consumption_only_value(
    registry, config, invalid_value
):

    with pytest.raises(TypeError):
        build_energy_snapshot(
            registry,
            HOUR,
            config,
            consumption_only_user_ids=invalid_value,
        )


# --------------------------------------------------
# TEST 20 — Compatible with MatchingInput
# --------------------------------------------------

def test_snapshot_can_build_matching_input(
    registry, config
):

    snapshot = build_energy_snapshot(
        registry, HOUR, config
    )

    matching_config = MatchingConfig.model_validate(
        load_json(
            FIXTURES / "matching-config.sample.json"
        )
    )

    matching_input = MatchingInput.from_snapshot(
        snapshot,
        matching_config,
    )

    assert matching_input.snapshot_id == snapshot.snapshot_id
    assert matching_input.time_slot == snapshot.time_slot
    assert len(matching_input.users) == len(snapshot.users)
