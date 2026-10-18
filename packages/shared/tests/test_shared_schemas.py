
import json
import subprocess
import sys
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator
from referencing import Registry, Resource


# --------------------------------------------------
# 1. Locate the shared package
# --------------------------------------------------

SHARED_DIR = Path(__file__).resolve().parents[1]

SCHEMA_DIR = SHARED_DIR / "schemas"
FIXTURE_DIR = SHARED_DIR / "fixtures"
SCRIPT_DIR = SHARED_DIR / "scripts"


# --------------------------------------------------
# 2. List the schemas we want to test
# --------------------------------------------------

SCHEMA_FILES = [
    "common.schema.json",
    "user.schema.json",
    "user-registry.schema.json",
    "hourly-energy-record.schema.json",
    "energy-snapshot.schema.json",
    "matching-config.schema.json",
    "matching-input.schema.json",
    "match-result.schema.json",
    "matching-output.schema.json",
    "delivery-record.schema.json",
]


# --------------------------------------------------
# 3. List the example JSON files
# --------------------------------------------------

FIXTURE_FILES = [
    "user-registry.sample.json",
    "hourly-energy-records.sample.json",
    "energy-snapshot.sample.json",
    "matching-config.sample.json",
    "matching-input.sample.json",
    "matching-output.sample.json",
    "delivery-record.sample.json",
]


# --------------------------------------------------
# 4. List existing validation scripts
# --------------------------------------------------

VALIDATION_SCRIPTS = [
    "validate_user_registry.py",
    "validate_hourly_energy_records.py",
    "validate_energy_snapshot.py",
    "validate_matching_input.py",
    "validate_matching_output.py",
    "validate_delivery_record.py",
]


# --------------------------------------------------
# 5. Helper: load JSON
# --------------------------------------------------

def load_json(path: Path):
    return json.loads(
        path.read_text(encoding="utf-8")
    )


# --------------------------------------------------
# 6. Helper: build local schema registry
# --------------------------------------------------

def build_registry():
    registry = Registry()

    for filename in SCHEMA_FILES:
        schema = load_json(
            SCHEMA_DIR / filename
        )

        registry = registry.with_resource(
            schema["$id"],
            Resource.from_contents(schema)
        )

    return registry


# --------------------------------------------------
# 7. Helper: find $ref in nested JSON
# --------------------------------------------------

def find_references(value):

    if isinstance(value, dict):

        if "$ref" in value:
            yield value["$ref"]

        for child in value.values():
            yield from find_references(child)

    elif isinstance(value, list):

        for child in value:
            yield from find_references(child)


# --------------------------------------------------
# TEST 1 — Every JSON Schema is valid
# --------------------------------------------------

@pytest.mark.parametrize("filename", SCHEMA_FILES)
def test_schema_is_valid(filename):

    schema = load_json(
        SCHEMA_DIR / filename
    )

    Draft202012Validator.check_schema(schema)

    assert schema["$schema"] == (
        "https://json-schema.org/draft/2020-12/schema"
    )

    assert schema["$id"] == (
        "https://energy-trading.example/schemas/"
        + filename
    )


# --------------------------------------------------
# TEST 2 — Every schema reference resolves
# --------------------------------------------------

@pytest.mark.parametrize("filename", SCHEMA_FILES)
def test_schema_references(filename):

    schema = load_json(
        SCHEMA_DIR / filename
    )

    registry = build_registry()

    resolver = registry.resolver(
        base_uri=schema["$id"]
    )

    for reference in find_references(schema):

        resolved = resolver.lookup(reference)

        assert resolved.contents is not None


# --------------------------------------------------
# TEST 3 — Every fixture is valid JSON
# --------------------------------------------------

@pytest.mark.parametrize("filename", FIXTURE_FILES)
def test_fixture_is_valid_json(filename):

    data = load_json(
        FIXTURE_DIR / filename
    )

    assert isinstance(data, (dict, list))


# --------------------------------------------------
# TEST 4 — Run every existing validation script
# --------------------------------------------------

@pytest.mark.parametrize("filename", VALIDATION_SCRIPTS)
def test_validation_script(filename):

    script_path = SCRIPT_DIR / filename

    assert script_path.exists(), (
        f"Missing validation script: {filename}"
    )

    result = subprocess.run(
        [
            sys.executable,
            str(script_path)
        ],
        capture_output=True,
        text=True,
        timeout=60,
        check=False
    )

    assert result.returncode == 0, (
        f"Validation failed: {filename}\n"
        f"STDOUT:\n{result.stdout}\n"
        f"STDERR:\n{result.stderr}"
    )

    assert "PASS:" in result.stdout
