
"""
Tests for the Energy Data Generator user registry loader.
"""

import json
from pathlib import Path

import pytest

from data_generator.registry import load_user_registry


# --------------------------------------------------
# 1. Locate the shared user fixture
# --------------------------------------------------

ROOT = Path(__file__).resolve().parents[3]

SAMPLE_PATH = (
    ROOT
    / "packages"
    / "shared"
    / "fixtures"
    / "user-registry.sample.json"
)


# --------------------------------------------------
# 2. Load sample data for each test
# --------------------------------------------------

@pytest.fixture
def sample_data():

    return json.loads(
        SAMPLE_PATH.read_text(
            encoding="utf-8"
        )
    )


# --------------------------------------------------
# 3. Helper to write temporary registry files
# --------------------------------------------------

def write_registry(tmp_path, data):

    path = tmp_path / "users.json"

    path.write_text(
        json.dumps(data),
        encoding="utf-8"
    )

    return path


# --------------------------------------------------
# TEST 1 — Load the existing user registry
# --------------------------------------------------

def test_loads_sample_registry():

    registry = load_user_registry(SAMPLE_PATH)

    assert len(registry.users) == 2

    assert registry.users[0].name == "Solar House"

    assert registry.users[1].name == "Consumer House"


# --------------------------------------------------
# TEST 2 — Do not generate blockchain accounts
# --------------------------------------------------

def test_loader_does_not_create_wallets():

    registry = load_user_registry(SAMPLE_PATH)

    for user in registry.users:

        assert user.hedera_account_id is None

        assert user.evm_address is None


# --------------------------------------------------
# TEST 3 — Reject a missing file
# --------------------------------------------------

def test_rejects_missing_file(tmp_path):

    missing_path = tmp_path / "missing.json"

    with pytest.raises(
        FileNotFoundError,
        match="User registry file not found"
    ):
        load_user_registry(missing_path)


# --------------------------------------------------
# TEST 4 — Reject malformed JSON
# --------------------------------------------------

def test_rejects_malformed_json(tmp_path):

    path = tmp_path / "invalid.json"

    path.write_text(
        "{ invalid JSON }",
        encoding="utf-8"
    )

    with pytest.raises(
        ValueError,
        match="Invalid user registry"
    ):
        load_user_registry(path)


# --------------------------------------------------
# TEST 5 — Reject missing required user fields
# --------------------------------------------------

def test_rejects_missing_user_field(
    tmp_path,
    sample_data
):

    del sample_data["users"][0]["name"]

    path = write_registry(
        tmp_path,
        sample_data
    )

    with pytest.raises(ValueError):
        load_user_registry(path)


# --------------------------------------------------
# TEST 6 — Reject duplicate user IDs
# --------------------------------------------------

def test_rejects_duplicate_users(
    tmp_path,
    sample_data
):

    sample_data["users"][1]["userId"] = (
        sample_data["users"][0]["userId"]
    )

    path = write_registry(
        tmp_path,
        sample_data
    )

    with pytest.raises(
        ValueError,
        match="duplicate userId"
    ):
        load_user_registry(path)


# --------------------------------------------------
# TEST 7 — Reject invalid reputation
# --------------------------------------------------

def test_rejects_invalid_reputation(
    tmp_path,
    sample_data
):

    sample_data["users"][0]["reputation"] = 150

    path = write_registry(
        tmp_path,
        sample_data
    )

    with pytest.raises(ValueError):
        load_user_registry(path)


# --------------------------------------------------
# TEST 8 — Reject incomplete wallet information
# --------------------------------------------------

def test_rejects_incomplete_wallets(
    tmp_path,
    sample_data
):

    sample_data["users"][0]["evmAddress"] = (
        "0x" + "a" * 40
    )

    path = write_registry(
        tmp_path,
        sample_data
    )

    with pytest.raises(
        ValueError,
        match="must be provided together"
    ):
        load_user_registry(path)


# --------------------------------------------------
# TEST 9 — Accept backend-enriched users
# --------------------------------------------------

def test_loads_users_with_wallets(
    tmp_path,
    sample_data
):

    user = sample_data["users"][0]

    user["hederaAccountId"] = "0.0.12345"

    user["evmAddress"] = "0x" + "a" * 40

    path = write_registry(
        tmp_path,
        sample_data
    )

    registry = load_user_registry(path)

    assert (
        registry.users[0].hedera_account_id
        == "0.0.12345"
    )

    assert (
        registry.users[0].evm_address
        == "0x" + "a" * 40
    )


# --------------------------------------------------
# TEST 10 — Reject an empty user registry
# --------------------------------------------------

def test_rejects_empty_registry(
    tmp_path,
    sample_data
):

    sample_data["users"] = []

    path = write_registry(
        tmp_path,
        sample_data
    )

    with pytest.raises(ValueError):
        load_user_registry(path)
