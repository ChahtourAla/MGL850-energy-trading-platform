
"""
End-to-end integration tests for the Energy Data Generator.

Pipeline:
1. Generate static users using the real CLI.
2. Enrich them with dummy wallet identifiers.
3. Validate the enriched registry.
4. Generate hourly EnergySnapshot JSON files.
5. Validate the files against shared JSON Schemas.
6. Build MatchingInput objects.

No real Hedera accounts or blockchain transactions.
"""

import json
import subprocess
import sys

from pathlib import Path
from uuid import uuid4

import pytest

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

from p2p_energy_shared import (
    EnergySnapshot,
    MatchingConfig,
    MatchingInput,
)


# --------------------------------------------------
# 1. Project paths
# --------------------------------------------------

ROOT = Path(__file__).resolve().parents[3]

SERVICE_DIR = (
    ROOT / "services" / "data-generator"
)

SHARED_DIR = ROOT / "packages" / "shared"

USER_CONFIG = (
    SERVICE_DIR
    / "config"
    / "user-registry-config.json"
)

ENERGY_CONFIG = (
    SERVICE_DIR
    / "config"
    / "energy-generation-config.json"
)

HOUR_MIDDAY = "2026-10-18T12:00:00Z"
HOUR_EVENING = "2026-10-18T20:00:00Z"


# --------------------------------------------------
# 2. Run the real CLI as a separate Python process
# --------------------------------------------------

def run_cli(*arguments):
    """
    Execute the Data Generator exactly as an
    external application would execute it.
    """

    command = [
        sys.executable,
        "-m",
        "data_generator.cli",
        *map(str, arguments),
    ]

    return subprocess.run(
        command,
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )


# --------------------------------------------------
# 3. Read a JSON file
# --------------------------------------------------

def read_json(path):
    return json.loads(
        Path(path).read_text(encoding="utf-8")
    )


# --------------------------------------------------
# 4. Prepare the full integration environment
# --------------------------------------------------

@pytest.fixture
def environment(tmp_path):
    """
    Generate 12 users through the CLI.

    Add test-only wallet identifiers.

    For predictable behavior:
    - Household 0001 has solar generation.
    - The other 11 households are consumption-only.
    - Buyer energy preferences are ANY.
    - Prices and quantities have no random variation.
    """

    static_path = tmp_path / "static-users.json"

    generated = run_cli(
        "generate-users",
        "--config", USER_CONFIG,
        "--output", static_path,
    )

    assert generated.returncode == 0, generated.stderr

    static_data = read_json(static_path)

    assert len(static_data["users"]) == 12

    # ----------------------------------------------
    # A. Add dummy wallets for integration testing
    # ----------------------------------------------

    enriched_data = json.loads(
        json.dumps(static_data)
    )

    for index, user in enumerate(
        enriched_data["users"],
        start=1,
    ):

        user["hederaAccountId"] = (
            f"0.0.{900000 + index}"
        )

        user["evmAddress"] = (
            f"0x{index:040x}"
        )

        # Consumption-only users accept any source.
        if index > 1:
            user["preferredEnergyType"] = "ANY"

    enriched_path = tmp_path / "enriched-users.json"

    enriched_path.write_text(
        json.dumps(enriched_data, indent=2) + "\n",
        encoding="utf-8",
    )

    # ----------------------------------------------
    # B. Make the energy scenario predictable
    # ----------------------------------------------

    config_data = read_json(ENERGY_CONFIG)

    config_data["productionEnergyTypeWeights"] = {
        "SOLAR": 1.0,
        "WIND": 0.0,
        "HYDRO": 0.0,
        "GRID": 0.0,
        "MIXED": 0.0,
    }

    config_data["productionVariationFraction"] = 0.0
    config_data["consumptionVariationFraction"] = 0.0

    config_data["sellerAskPriceRange"] = {
        "minMicrousdPerKwh": 140000,
        "maxMicrousdPerKwh": 140000,
    }

    config_data["buyerMaxPriceRange"] = {
        "minMicrousdPerKwh": 170000,
        "maxMicrousdPerKwh": 170000,
    }

    config_path = tmp_path / "energy-config.json"

    config_path.write_text(
        json.dumps(config_data, indent=2) + "\n",
        encoding="utf-8",
    )

    consumption_only_ids = [
        user["userId"]
        for user in enriched_data["users"][1:]
    ]

    return {
        "static_path": static_path,
        "enriched_path": enriched_path,
        "config_path": config_path,
        "consumption_only_ids": consumption_only_ids,
        "output_dir": tmp_path / "snapshots",
    }


# --------------------------------------------------
# 5. Build the snapshot CLI arguments
# --------------------------------------------------

def snapshot_arguments(
    environment,
    time_slot=HOUR_MIDDAY,
    registry_path=None,
):

    arguments = [
        "generate-snapshot",
        "--registry",
        registry_path or environment["enriched_path"],
        "--config",
        environment["config_path"],
        "--time-slot",
        time_slot,
        "--output-dir",
        environment["output_dir"],
    ]

    for user_id in environment["consumption_only_ids"]:
        arguments += [
            "--consumption-only-user-id",
            user_id,
        ]

    return arguments


# --------------------------------------------------
# 6. Load one generated snapshot
# --------------------------------------------------

def generate_and_read_snapshot(
    environment,
    time_slot=HOUR_MIDDAY,
):

    result = run_cli(
        *snapshot_arguments(
            environment,
            time_slot,
        )
    )

    assert result.returncode == 0, result.stderr

    expected_filename = (
        f"energy_snapshot_{time_slot[:13]}.json"
    )

    path = (
        environment["output_dir"]
        / expected_filename
    )

    assert path.is_file()

    snapshot = EnergySnapshot.model_validate_json(
        path.read_text(encoding="utf-8")
    )

    return snapshot, path


# ==================================================
# TEST 1 — User generation works end to end
# ==================================================

def test_generates_twelve_static_users(environment):

    data = read_json(environment["static_path"])

    assert len(data["users"]) == 12

    assert all(
        "evmAddress" not in user
        for user in data["users"]
    )

    assert all(
        "hederaAccountId" not in user
        for user in data["users"]
    )


# ==================================================
# TEST 2 — Wallet-enriched registry passes the CLI
# ==================================================

def test_enriched_registry_is_wallet_ready(environment):

    result = run_cli(
        "validate-users",
        "--input",
        environment["enriched_path"],
        "--require-wallets",
    )

    assert result.returncode == 0, result.stderr

    assert (
        "12 valid users" in result.stdout
    )

    assert (
        "unique Hedera accounts" in result.stdout
    )


# ==================================================
# TEST 3 — Midday snapshot has buyers and sellers
# ==================================================

def test_midday_snapshot_contains_market_roles(
    environment,
):

    snapshot, _ = generate_and_read_snapshot(
        environment
    )

    assert len(snapshot.users) == 12

    sellers = [
        record
        for record in snapshot.users
        if record.market_role.value == "SELLER"
    ]

    buyers = [
        record
        for record in snapshot.users
        if record.market_role.value == "BUYER"
    ]

    assert len(sellers) == 1
    assert len(buyers) == 11

    assert len({
        record.user_id for record in snapshot.users
    }) == 12


# ==================================================
# TEST 4 — Exported JSON follows the shared schema
# ==================================================

def test_generated_json_matches_schema(environment):

    _, path = generate_and_read_snapshot(environment)

    data = read_json(path)

    schemas_dir = SHARED_DIR / "schemas"

    schema_registry = Registry()

    for schema_path in sorted(
        schemas_dir.glob("*.schema.json")
    ):

        schema = read_json(schema_path)

        schema_registry = schema_registry.with_resource(
            schema["$id"],
            Resource.from_contents(schema),
        )

    energy_schema = read_json(
        schemas_dir / "energy-snapshot.schema.json"
    )

    validator = Draft202012Validator(
        energy_schema,
        registry=schema_registry,
        format_checker=FormatChecker(),
    )

    validator.validate(data)


# ==================================================
# TEST 5 — MatchingInput can read the new snapshot
# ==================================================

def test_snapshot_is_compatible_with_matching_input(
    environment,
):

    snapshot, _ = generate_and_read_snapshot(
        environment
    )

    matching_config = MatchingConfig.model_validate(
        read_json(
            SHARED_DIR
            / "fixtures"
            / "matching-config.sample.json"
        )
    )

    matching_input = MatchingInput.from_snapshot(
        snapshot,
        matching_config,
    )

    assert matching_input.snapshot_id == snapshot.snapshot_id
    assert matching_input.time_slot == snapshot.time_slot
    assert len(matching_input.users) == 12


# ==================================================
# TEST 6 — Energy amounts and prices are correct
# ==================================================

def test_midday_energy_and_price_values(environment):

    snapshot, _ = generate_and_read_snapshot(
        environment
    )

    seller = next(
        record for record in snapshot.users
        if record.market_role.value == "SELLER"
    )

    buyers = [
        record for record in snapshot.users
        if record.market_role.value == "BUYER"
    ]

    # Solar production at 12:00 UTC.
    assert seller.production_wh == 6500
    assert seller.consumption_wh == 2125

    assert seller.net_energy_wh == 4375
    assert seller.available_energy_wh == 4375

    assert seller.energy_type.value == "SOLAR"
    assert seller.ask_price_microusd_per_kwh == 140000

    for buyer in buyers:
        assert buyer.production_wh == 0
        assert buyer.required_energy_wh == 2125
        assert buyer.max_price_microusd_per_kwh == 170000


# ==================================================
# TEST 7 — CLI output is reproducible across runs
# ==================================================

def test_output_is_reproducible_across_processes(
    environment,
):

    _, path = generate_and_read_snapshot(
        environment
    )

    original_bytes = path.read_bytes()

    arguments = snapshot_arguments(environment)

    result = run_cli(
        *arguments,
        "--overwrite",
    )

    assert result.returncode == 0, result.stderr
    assert path.read_bytes() == original_bytes


# ==================================================
# TEST 8 — Solar generator becomes buyer at night
# ==================================================

def test_evening_snapshot_has_only_buyers(environment):

    snapshot, _ = generate_and_read_snapshot(
        environment,
        HOUR_EVENING,
    )

    assert len(snapshot.users) == 12

    assert all(
        record.production_wh == 0
        for record in snapshot.users
    )

    assert all(
        record.market_role.value == "BUYER"
        for record in snapshot.users
    )


# ==================================================
# TEST 9 — Separate hours produce separate JSON files
# ==================================================

def test_two_hours_generate_separate_files(environment):

    midday, midday_path = generate_and_read_snapshot(
        environment,
        HOUR_MIDDAY,
    )

    evening, evening_path = generate_and_read_snapshot(
        environment,
        HOUR_EVENING,
    )

    assert midday_path != evening_path
    assert midday_path.exists()
    assert evening_path.exists()

    assert midday.snapshot_id != evening.snapshot_id


# ==================================================
# TEST 10 — Static users cannot generate snapshots
# ==================================================

def test_static_registry_is_rejected(environment):

    result = run_cli(
        *snapshot_arguments(
            environment,
            registry_path=environment["static_path"],
        )
    )

    assert result.returncode == 2

    assert "missing blockchain wallet" in result.stderr

    assert not environment["output_dir"].exists()


# ==================================================
# TEST 11 — Invalid hourly timestamps are rejected
# ==================================================

def test_invalid_time_slot_is_rejected(environment):

    result = run_cli(
        *snapshot_arguments(
            environment,
            time_slot="2026-10-18T12:30:00Z",
        )
    )

    assert result.returncode == 2
    assert "ERROR:" in result.stderr

    assert not environment["output_dir"].exists()


# ==================================================
# TEST 12 — Existing snapshots are protected
# ==================================================

def test_existing_snapshot_cannot_be_overwritten(
    environment,
):

    _, path = generate_and_read_snapshot(
        environment
    )

    original_bytes = path.read_bytes()

    result = run_cli(
        *snapshot_arguments(environment)
    )

    assert result.returncode == 3
    assert "already exists" in result.stderr

    assert path.read_bytes() == original_bytes


# ==================================================
# TEST 13 — Unknown household IDs are rejected
# ==================================================

def test_unknown_consumption_only_id_is_rejected(
    environment,
):

    arguments = snapshot_arguments(environment)

    arguments += [
        "--consumption-only-user-id",
        str(uuid4()),
    ]

    result = run_cli(*arguments)

    assert result.returncode == 2

    assert (
        "Unknown consumption-only user IDs"
        in result.stderr
    )

    assert not environment["output_dir"].exists()
