
"""
Tests for EnergySnapshot JSON export and CLI.
"""

import json
from pathlib import Path
from uuid import uuid4

import pytest
from pydantic import ValidationError

from p2p_energy_shared import (
    EnergySnapshot,
    MarketRole,
)

from data_generator.cli import main
from data_generator.energy_config import load_energy_config
from data_generator.registry import load_user_registry
from data_generator.snapshot_builder import (
    build_energy_snapshot,
)
from data_generator.snapshot_io import (
    save_energy_snapshot,
    snapshot_filename,
)


# --------------------------------------------------
# 1. Project paths
# --------------------------------------------------

ROOT = Path(__file__).resolve().parents[3]
SERVICE_DIR = Path(__file__).resolve().parents[1]

ENERGY_CONFIG = (
    SERVICE_DIR
    / "config"
    / "energy-generation-config.json"
)

USER_CONFIG = (
    SERVICE_DIR
    / "config"
    / "user-registry-config.json"
)

SAMPLE_REGISTRY = (
    ROOT
    / "packages"
    / "shared"
    / "fixtures"
    / "user-registry.sample.json"
)

HOUR = "2026-10-18T12:00:00Z"

EXPECTED_FILENAME = (
    "energy_snapshot_2026-10-18T12.json"
)


# --------------------------------------------------
# 2. Create test-only enriched users
# --------------------------------------------------

@pytest.fixture
def enriched_registry_path(tmp_path):

    data = json.loads(
        SAMPLE_REGISTRY.read_text(
            encoding="utf-8"
        )
    )

    for index, user in enumerate(
        data["users"],
        start=1,
    ):
        # Dummy identifiers, not real Hedera accounts.
        user["hederaAccountId"] = f"0.0.{10000 + index}"
        user["evmAddress"] = f"0x{index:040x}"

    path = tmp_path / "enriched-registry.json"

    path.write_text(
        json.dumps(data, indent=2),
        encoding="utf-8",
    )

    return path


# --------------------------------------------------
# 3. Construct a valid snapshot for tests
# --------------------------------------------------

@pytest.fixture
def snapshot(enriched_registry_path):

    registry = load_user_registry(
        enriched_registry_path
    )

    config = load_energy_config(
        ENERGY_CONFIG
    )

    return build_energy_snapshot(
        registry,
        HOUR,
        config,
    )


# --------------------------------------------------
# 4. Build CLI command arguments
# --------------------------------------------------

def snapshot_command(
    registry_path,
    output_dir,
):
    return [
        "generate-snapshot",
        "--registry", str(registry_path),
        "--config", str(ENERGY_CONFIG),
        "--time-slot", HOUR,
        "--output-dir", str(output_dir),
    ]


# --------------------------------------------------
# TEST 1 — Correct output filename
# --------------------------------------------------

def test_snapshot_filename():

    assert snapshot_filename(HOUR) == EXPECTED_FILENAME


# --------------------------------------------------
# TEST 2 — Reject invalid filenames/timestamps
# --------------------------------------------------

@pytest.mark.parametrize(
    "time_slot",
    [
        "2026-10-18T12:30:00Z",
        "2026-02-30T12:00:00Z",
        "2026-10-18T12:00:00+00:00",
    ],
)
def test_rejects_invalid_filename_time_slot(
    time_slot,
):

    with pytest.raises(ValidationError):
        snapshot_filename(time_slot)


# --------------------------------------------------
# TEST 3 — Save and reload a complete snapshot
# --------------------------------------------------

def test_save_and_reload_snapshot(
    snapshot,
    tmp_path,
):

    saved = save_energy_snapshot(
        snapshot,
        tmp_path,
    )

    assert saved.name == EXPECTED_FILENAME
    assert saved.is_file()

    loaded = EnergySnapshot.model_validate_json(
        saved.read_text(encoding="utf-8")
    )

    assert loaded == snapshot


# --------------------------------------------------
# TEST 4 — Create missing output directories
# --------------------------------------------------

def test_creates_output_directory(
    snapshot,
    tmp_path,
):

    directory = (
        tmp_path
        / "nested"
        / "snapshots"
    )

    saved = save_energy_snapshot(
        snapshot,
        directory,
    )

    assert saved.is_file()
    assert saved.parent == directory


# --------------------------------------------------
# TEST 5 — Refuse accidental overwriting
# --------------------------------------------------

def test_refuses_overwrite(
    snapshot,
    tmp_path,
):

    save_energy_snapshot(
        snapshot,
        tmp_path,
    )

    with pytest.raises(
        FileExistsError,
        match="Snapshot already exists",
    ):
        save_energy_snapshot(
            snapshot,
            tmp_path,
        )


# --------------------------------------------------
# TEST 6 — Allow explicit overwriting
# --------------------------------------------------

def test_allows_explicit_overwrite(
    snapshot,
    tmp_path,
):

    saved = save_energy_snapshot(
        snapshot,
        tmp_path,
    )

    saved.write_text(
        "old content",
        encoding="utf-8",
    )

    save_energy_snapshot(
        snapshot,
        tmp_path,
        overwrite=True,
    )

    loaded = EnergySnapshot.model_validate_json(
        saved.read_text(encoding="utf-8")
    )

    assert loaded == snapshot


# --------------------------------------------------
# TEST 7 — Generate snapshot through CLI
# --------------------------------------------------

def test_cli_generates_snapshot(
    enriched_registry_path,
    tmp_path,
    capsys,
):

    directory = tmp_path / "output"

    result = main(
        snapshot_command(
            enriched_registry_path,
            directory,
        )
    )

    assert result == 0

    output_path = (
        directory / EXPECTED_FILENAME
    )

    assert output_path.is_file()

    snapshot = EnergySnapshot.model_validate_json(
        output_path.read_text(encoding="utf-8")
    )

    assert len(snapshot.users) == 2

    text = capsys.readouterr().out

    assert "PASS: generated snapshot" in text
    assert "Saved snapshot:" in text


# --------------------------------------------------
# TEST 8 — CLI output is reproducible
# --------------------------------------------------

def test_cli_generation_is_reproducible(
    enriched_registry_path,
    tmp_path,
):

    directory = tmp_path / "output"

    arguments = snapshot_command(
        enriched_registry_path,
        directory,
    )

    assert main(arguments) == 0

    output_path = directory / EXPECTED_FILENAME

    first_content = output_path.read_bytes()

    assert main(
        arguments + ["--overwrite"]
    ) == 0

    second_content = output_path.read_bytes()

    assert first_content == second_content


# --------------------------------------------------
# TEST 9 — Support consumption-only households
# --------------------------------------------------

def test_cli_consumption_only_household(
    enriched_registry_path,
    tmp_path,
):

    user_id = (
        "22222222-2222-4222-8222-222222222222"
    )

    arguments = snapshot_command(
        enriched_registry_path,
        tmp_path / "output",
    )

    arguments += [
        "--consumption-only-user-id",
        user_id,
    ]

    assert main(arguments) == 0

    path = (
        tmp_path
        / "output"
        / EXPECTED_FILENAME
    )

    snapshot = EnergySnapshot.model_validate_json(
        path.read_text(encoding="utf-8")
    )

    record = next(
        item
        for item in snapshot.users
        if str(item.user_id) == user_id
    )

    assert record.production_wh == 0
    assert record.market_role == MarketRole.BUYER


# --------------------------------------------------
# TEST 10 — Do not accept users without wallets
# --------------------------------------------------

def test_cli_rejects_static_registry(
    tmp_path,
    capsys,
):

    directory = tmp_path / "output"

    result = main(
        snapshot_command(
            SAMPLE_REGISTRY,
            directory,
        )
    )

    assert result == 2

    assert not (
        directory / EXPECTED_FILENAME
    ).exists()

    assert "missing blockchain wallet" in (
        capsys.readouterr().err
    )


# --------------------------------------------------
# TEST 11 — Reject unknown consumption-only IDs
# --------------------------------------------------

def test_cli_rejects_unknown_user(
    enriched_registry_path,
    tmp_path,
    capsys,
):

    arguments = snapshot_command(
        enriched_registry_path,
        tmp_path / "output",
    )

    arguments += [
        "--consumption-only-user-id",
        str(uuid4()),
    ]

    result = main(arguments)

    assert result == 2

    assert "Unknown consumption-only user IDs" in (
        capsys.readouterr().err
    )


# --------------------------------------------------
# TEST 12 — Reject a missing registry
# --------------------------------------------------

def test_cli_rejects_missing_registry(
    tmp_path,
):

    missing_path = tmp_path / "missing-users.json"

    result = main(
        snapshot_command(
            missing_path,
            tmp_path / "output",
        )
    )

    assert result == 2


# --------------------------------------------------
# TEST 13 — Reject missing energy configuration
# --------------------------------------------------

def test_cli_rejects_missing_config(
    enriched_registry_path,
    tmp_path,
):

    arguments = snapshot_command(
        enriched_registry_path,
        tmp_path / "output",
    )

    index = arguments.index("--config")

    arguments[index + 1] = str(
        tmp_path / "missing-config.json"
    )

    assert main(arguments) == 2


# --------------------------------------------------
# TEST 14 — Report output writing failures
# --------------------------------------------------

def test_cli_reports_write_failure(
    enriched_registry_path,
    tmp_path,
):

    # A regular file cannot be used as a directory.
    blocker = tmp_path / "not-a-directory"

    blocker.write_text(
        "blocker",
        encoding="utf-8",
    )

    result = main(
        snapshot_command(
            enriched_registry_path,
            blocker,
        )
    )

    assert result == 3


# --------------------------------------------------
# TEST 15 — CLI protects existing snapshots
# --------------------------------------------------

def test_cli_prevents_overwriting(
    enriched_registry_path,
    tmp_path,
):

    arguments = snapshot_command(
        enriched_registry_path,
        tmp_path / "output",
    )

    assert main(arguments) == 0

    assert main(arguments) == 3


# --------------------------------------------------
# TEST 16 — Help documents the new command
# --------------------------------------------------

def test_cli_help_includes_snapshot_command(
    capsys,
):

    with pytest.raises(SystemExit) as result:
        main(["--help"])

    assert result.value.code == 0

    output = capsys.readouterr().out

    assert "generate-snapshot" in output

    with pytest.raises(SystemExit) as result:
        main(["generate-snapshot", "--help"])

    assert result.value.code == 0

    output = capsys.readouterr().out

    assert "--registry" in output
    assert "--time-slot" in output
    assert "--output-dir" in output


# --------------------------------------------------
# TEST 17 — Require snapshot CLI arguments
# --------------------------------------------------

def test_cli_requires_snapshot_arguments():

    with pytest.raises(SystemExit) as result:
        main(["generate-snapshot"])

    assert result.value.code == 2


# --------------------------------------------------
# TEST 18 — Preserve previous CLI behavior
# --------------------------------------------------

def test_cli_preserves_existing_commands(
    tmp_path,
    capsys,
):

    registry_output = tmp_path / "users.json"

    generated = main([
        "generate-users",
        "--config", str(USER_CONFIG),
        "--output", str(registry_output),
    ])

    assert generated == 0
    assert registry_output.exists()

    validated = main([
        "validate-users",
        "--input", str(registry_output),
    ])

    assert validated == 0

    assert main([]) == 0

    output = capsys.readouterr().out

    assert "Energy simulation is not implemented yet" in output
