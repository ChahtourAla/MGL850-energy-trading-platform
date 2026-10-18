
"""
Tests for the Data Generator registry CLI.
"""

import json
from pathlib import Path

import pytest

from data_generator.cli import main
from data_generator.registry import load_user_registry


# --------------------------------------------------
# 1. Test file locations
# --------------------------------------------------

ROOT = Path(__file__).resolve().parents[3]

CONFIG_PATH = (
    ROOT
    / "services"
    / "data-generator"
    / "config"
    / "user-registry-config.json"
)

SAMPLE_PATH = (
    ROOT
    / "packages"
    / "shared"
    / "fixtures"
    / "user-registry.sample.json"
)


# --------------------------------------------------
# 2. Helpers
# --------------------------------------------------

def generate_command(output_path, config_path=CONFIG_PATH):
    return [
        "generate-users",
        "--config", str(config_path),
        "--output", str(output_path),
    ]


def create_enriched_registry(tmp_path):
    """
    Create test-only wallet information.

    These are dummy addresses, not real blockchain
    accounts. They are never used for transactions.
    """
    data = json.loads(
        SAMPLE_PATH.read_text(encoding="utf-8")
    )

    for index, user in enumerate(data["users"], start=1):
        user["hederaAccountId"] = f"0.0.{10000 + index}"
        user["evmAddress"] = f"0x{index:040x}"

    path = tmp_path / "enriched-users.json"

    path.write_text(
        json.dumps(data),
        encoding="utf-8",
    )

    return path


# --------------------------------------------------
# TEST 1 — Generate users through the CLI
# --------------------------------------------------

def test_cli_generates_users(tmp_path, capsys):

    output_path = tmp_path / "users.json"

    result = main(
        generate_command(output_path)
    )

    assert result == 0
    assert output_path.is_file()

    registry = load_user_registry(output_path)

    assert len(registry.users) == 12

    output = capsys.readouterr().out

    assert "PASS: generated 12 users" in output


# --------------------------------------------------
# TEST 2 — Explicit overwrite stays reproducible
# --------------------------------------------------

def test_cli_overwrite_is_reproducible(tmp_path):

    output_path = tmp_path / "users.json"

    assert main(generate_command(output_path)) == 0

    first_content = output_path.read_bytes()

    assert main(
        generate_command(output_path) + ["--overwrite"]
    ) == 0

    second_content = output_path.read_bytes()

    assert first_content == second_content


# --------------------------------------------------
# TEST 3 — Reject accidental overwriting
# --------------------------------------------------

def test_cli_rejects_overwrite(tmp_path, capsys):

    output_path = tmp_path / "users.json"

    assert main(generate_command(output_path)) == 0

    result = main(generate_command(output_path))

    assert result == 3

    error = capsys.readouterr().err

    assert "already exists" in error


# --------------------------------------------------
# TEST 4 — Reject missing configuration
# --------------------------------------------------

def test_cli_rejects_missing_config(tmp_path, capsys):

    output_path = tmp_path / "users.json"
    missing_config = tmp_path / "missing-config.json"

    result = main(
        generate_command(output_path, missing_config)
    )

    assert result == 2
    assert not output_path.exists()

    assert "ERROR:" in capsys.readouterr().err


# --------------------------------------------------
# TEST 5 — Reject invalid configuration
# --------------------------------------------------

def test_cli_rejects_invalid_config(tmp_path):

    config = json.loads(
        CONFIG_PATH.read_text(encoding="utf-8")
    )

    config["userCount"] = 0

    config_path = tmp_path / "invalid-config.json"

    config_path.write_text(
        json.dumps(config),
        encoding="utf-8",
    )

    output_path = tmp_path / "users.json"

    result = main(
        generate_command(output_path, config_path)
    )

    assert result == 2
    assert not output_path.exists()


# --------------------------------------------------
# TEST 6 — Validate a static user registry
# --------------------------------------------------

def test_cli_validates_static_registry(capsys):

    result = main([
        "validate-users",
        "--input", str(SAMPLE_PATH),
    ])

    assert result == 0

    output = capsys.readouterr().out

    assert "PASS: registry contains 2 valid users" in output
    assert "Wallet-ready users: 0/2" in output


# --------------------------------------------------
# TEST 7 — Static users are not wallet-ready
# --------------------------------------------------

def test_cli_rejects_missing_wallets(capsys):

    result = main([
        "validate-users",
        "--input", str(SAMPLE_PATH),
        "--require-wallets",
    ])

    assert result == 2

    error = capsys.readouterr().err

    assert "missing blockchain wallet" in error


# --------------------------------------------------
# TEST 8 — Accept backend-enriched user profiles
# --------------------------------------------------

def test_cli_accepts_wallet_ready_registry(
    tmp_path,
    capsys,
):

    enriched_path = create_enriched_registry(tmp_path)

    result = main([
        "validate-users",
        "--input", str(enriched_path),
        "--require-wallets",
    ])

    assert result == 0

    output = capsys.readouterr().out

    assert "PASS: registry contains 2 valid users" in output
    assert "unique Hedera accounts" in output


# --------------------------------------------------
# TEST 9 — Reject duplicate EVM addresses
# --------------------------------------------------

def test_cli_rejects_duplicate_evm_addresses(
    tmp_path,
    capsys,
):

    path = create_enriched_registry(tmp_path)

    data = json.loads(path.read_text(encoding="utf-8"))

    data["users"][1]["evmAddress"] = (
        data["users"][0]["evmAddress"]
    )

    path.write_text(
        json.dumps(data),
        encoding="utf-8",
    )

    result = main([
        "validate-users",
        "--input", str(path),
        "--require-wallets",
    ])

    assert result == 2

    assert "Duplicate EVM address" in capsys.readouterr().err


# --------------------------------------------------
# TEST 10 — Reject duplicate Hedera account IDs
# --------------------------------------------------

def test_cli_rejects_duplicate_hedera_accounts(
    tmp_path,
    capsys,
):

    path = create_enriched_registry(tmp_path)

    data = json.loads(path.read_text(encoding="utf-8"))

    data["users"][1]["hederaAccountId"] = (
        data["users"][0]["hederaAccountId"]
    )

    path.write_text(
        json.dumps(data),
        encoding="utf-8",
    )

    result = main([
        "validate-users",
        "--input", str(path),
        "--require-wallets",
    ])

    assert result == 2

    assert "Duplicate Hedera account ID" in capsys.readouterr().err


# --------------------------------------------------
# TEST 11 — Reject malformed registry files
# --------------------------------------------------

def test_cli_rejects_invalid_registry(tmp_path, capsys):

    path = tmp_path / "invalid-users.json"

    path.write_text(
        "{ invalid JSON }",
        encoding="utf-8",
    )

    result = main([
        "validate-users",
        "--input", str(path),
    ])

    assert result == 2

    assert "ERROR:" in capsys.readouterr().err


# --------------------------------------------------
# TEST 12 — Required arguments are enforced
# --------------------------------------------------

def test_cli_requires_generation_arguments():

    with pytest.raises(SystemExit) as result:
        main([
            "generate-users",
            "--config", str(CONFIG_PATH),
        ])

    assert result.value.code == 2


# --------------------------------------------------
# TEST 13 — Preserve the original CLI behavior
# --------------------------------------------------

def test_cli_without_command(capsys):

    result = main([])

    assert result == 0

    output = capsys.readouterr().out

    assert "Energy simulation is not implemented yet" in output
