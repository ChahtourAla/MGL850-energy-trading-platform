
import json
from pathlib import Path

import pytest

from jsonschema import (
    Draft202012Validator,
    FormatChecker,
)

from pydantic import ValidationError

from referencing import Registry, Resource

from p2p_energy_shared.models import (
    PreferredEnergyType,
    UserRegistry,
)


# --------------------------------------------------
# 1. Locate shared fixtures and schemas
# --------------------------------------------------

SHARED_DIR = Path(__file__).resolve().parents[2]

FIXTURE_PATH = (
    SHARED_DIR
    / "fixtures"
    / "user-registry.sample.json"
)

SCHEMA_DIR = SHARED_DIR / "schemas"


# --------------------------------------------------
# 2. Load sample data for every test
# --------------------------------------------------

@pytest.fixture
def registry_data():

    return json.loads(
        FIXTURE_PATH.read_text(
            encoding="utf-8"
        )
    )


# --------------------------------------------------
# TEST 1 — Read our existing registry
# --------------------------------------------------

def test_loads_existing_user_fixture(registry_data):

    registry = UserRegistry.model_validate(
        registry_data
    )

    assert registry.schema_version == "1.0.0"

    assert len(registry.users) == 2

    assert (
        registry.users[0].preferred_energy_type
        == PreferredEnergyType.SOLAR
    )


# --------------------------------------------------
# TEST 2 — Python output matches JSON Schema
# --------------------------------------------------

def test_serialization_matches_json_schema(
    registry_data
):

    parsed = UserRegistry.model_validate(
        registry_data
    )

    serialized = parsed.model_dump(
        mode="json",
        by_alias=True,
        exclude_none=True
    )

    assert serialized == registry_data

    # Load existing JSON Schema definitions
    local_registry = Registry()

    schema_names = [
        "common.schema.json",
        "user.schema.json",
        "user-registry.schema.json",
    ]

    for filename in schema_names:

        schema = json.loads(
            (SCHEMA_DIR / filename).read_text(
                encoding="utf-8"
            )
        )

        local_registry = local_registry.with_resource(
            schema["$id"],
            Resource.from_contents(schema)
        )

    registry_schema = json.loads(
        (
            SCHEMA_DIR / "user-registry.schema.json"
        ).read_text(encoding="utf-8")
    )

    # Validate the Python-generated JSON
    validator = Draft202012Validator(
        registry_schema,
        registry=local_registry,
        format_checker=FormatChecker()
    )

    validator.validate(serialized)


# --------------------------------------------------
# TEST 3 — Reject invalid field values
# --------------------------------------------------

@pytest.mark.parametrize(
    "field, value",
    [
        ("reputation", 101),
        ("reputation", "92"),
        ("preferredEnergyType", "NUCLEAR"),
        ("email", "not-an-email"),
        ("name", ""),
    ],
)
def test_rejects_invalid_user_fields(
    registry_data,
    field,
    value
):

    registry_data["users"][0][field] = value

    with pytest.raises(ValidationError):
        UserRegistry.model_validate(
            registry_data
        )


# --------------------------------------------------
# TEST 4 — Accept complete wallet information
# --------------------------------------------------

def test_accepts_complete_wallet_pair(registry_data):

    user = registry_data["users"][0]

    user["hederaAccountId"] = "0.0.12345"
    user["evmAddress"] = "0x" + "a" * 40

    parsed = UserRegistry.model_validate(
        registry_data
    )

    assert (
        parsed.users[0].hedera_account_id
        == "0.0.12345"
    )


# --------------------------------------------------
# TEST 5 — Reject incomplete wallet information
# --------------------------------------------------

def test_rejects_incomplete_wallet_pair(
    registry_data
):

    registry_data["users"][0]["evmAddress"] = (
        "0x" + "a" * 40
    )

    with pytest.raises(ValidationError):
        UserRegistry.model_validate(
            registry_data
        )


# --------------------------------------------------
# TEST 6 — Reject explicit null wallet fields
# --------------------------------------------------

def test_rejects_explicit_null_wallet(
    registry_data
):

    registry_data["users"][0]["evmAddress"] = None

    with pytest.raises(ValidationError):
        UserRegistry.model_validate(
            registry_data
        )


# --------------------------------------------------
# TEST 7 — Reject duplicate user IDs
# --------------------------------------------------

def test_rejects_duplicate_user_id(registry_data):

    registry_data["users"][1]["userId"] = (
        registry_data["users"][0]["userId"]
    )

    with pytest.raises(
        ValidationError,
        match="duplicate userId"
    ):
        UserRegistry.model_validate(
            registry_data
        )


# --------------------------------------------------
# TEST 8 — Reject duplicate email addresses
# --------------------------------------------------

def test_rejects_duplicate_email_case_insensitively(
    registry_data
):

    registry_data["users"][1]["email"] = (
        "SOLAR@example.com"
    )

    with pytest.raises(
        ValidationError,
        match="duplicate email"
    ):
        UserRegistry.model_validate(
            registry_data
        )


# --------------------------------------------------
# TEST 9 — Reject unknown fields
# --------------------------------------------------

def test_rejects_extra_user_fields(registry_data):

    registry_data["users"][0]["unknownField"] = True

    with pytest.raises(ValidationError):
        UserRegistry.model_validate(
            registry_data
        )
