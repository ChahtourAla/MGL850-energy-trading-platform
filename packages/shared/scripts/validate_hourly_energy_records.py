
import json
import sys
from copy import deepcopy
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource


# --------------------------------------------------
# 1. Locate the schemas and fixtures
# --------------------------------------------------

shared_dir = Path(__file__).resolve().parents[1]

schema_dir = shared_dir / "schemas"
fixture_dir = shared_dir / "fixtures"


def load_json(path: Path):
    return json.loads(
        path.read_text(encoding="utf-8")
    )


# --------------------------------------------------
# 2. Load and register the schemas
# --------------------------------------------------

schema_names = [
    "common.schema.json",
    "hourly-energy-record.schema.json",
]

registry = Registry()

for name in schema_names:
    schema = load_json(schema_dir / name)

    Draft202012Validator.check_schema(schema)

    registry = registry.with_resource(
        schema["$id"],
        Resource.from_contents(schema)
    )


hourly_schema = load_json(
    schema_dir / "hourly-energy-record.schema.json"
)

validator = Draft202012Validator(
    hourly_schema,
    registry=registry,
    format_checker=FormatChecker()
)


# --------------------------------------------------
# 3. Validate one hourly energy record
# --------------------------------------------------

def validate_record(record):
    # Check the JSON Schema rules.
    errors = list(
        validator.iter_errors(record)
    )

    if errors:
        raise ValueError(
            errors[0].message
        )

    # Check the energy calculation.
    expected_net = (
        record["productionWh"]
        - record["consumptionWh"]
    )

    if record["netEnergyWh"] != expected_net:
        raise ValueError(
            "Incorrect netEnergyWh calculation"
        )

    # Determine the correct market role.
    if expected_net > 0:
        expected_role = "SELLER"
    elif expected_net < 0:
        expected_role = "BUYER"
    else:
        expected_role = "NEUTRAL"

    if record["marketRole"] != expected_role:
        raise ValueError(
            "Incorrect marketRole"
        )

    # Verify seller and buyer energy quantities.
    expected_available = max(expected_net, 0)
    expected_required = max(-expected_net, 0)

    if record["availableEnergyWh"] != expected_available:
        raise ValueError(
            "Incorrect availableEnergyWh"
        )

    if record["requiredEnergyWh"] != expected_required:
        raise ValueError(
            "Incorrect requiredEnergyWh"
        )


# --------------------------------------------------
# 4. Load and validate example records
# --------------------------------------------------

records = load_json(
    fixture_dir / "hourly-energy-records.sample.json"
)

if not isinstance(records, list) or not records:
    raise ValueError(
        "Expected a non-empty list of hourly records"
    )

for record in records:
    validate_record(record)

print(
    f"PASS: {len(records)} hourly records are valid"
)


# --------------------------------------------------
# 5. Check record IDs and user IDs
# --------------------------------------------------

record_ids = [
    record["recordId"]
    for record in records
]

user_ids = [
    record["userId"]
    for record in records
]

if len(record_ids) != len(set(record_ids)):
    raise ValueError(
        "Duplicate recordId found"
    )

if len(user_ids) != len(set(user_ids)):
    raise ValueError(
        "Duplicate userId in hourly snapshot"
    )


# --------------------------------------------------
# 6. Check that all users are registered
# --------------------------------------------------

user_registry = load_json(
    fixture_dir / "user-registry.sample.json"
)

known_user_ids = {
    user["userId"]
    for user in user_registry["users"]
}

for record in records:
    if record["userId"] not in known_user_ids:
        raise ValueError(
            "Hourly record references an unknown user"
        )

print("PASS: all records reference known users")


# --------------------------------------------------
# 7. Check the hourly time slot
# --------------------------------------------------

time_slots = {
    record["timeSlot"]
    for record in records
}

if len(time_slots) != 1:
    raise ValueError(
        "Records do not belong to the same hour"
    )

print("PASS: all records belong to the same hour")


# --------------------------------------------------
# 8. Test the NEUTRAL market role
# --------------------------------------------------

neutral_record = deepcopy(records[0])

neutral_record["productionWh"] = 2000
neutral_record["consumptionWh"] = 2000
neutral_record["netEnergyWh"] = 0

neutral_record["marketRole"] = "NEUTRAL"
neutral_record["availableEnergyWh"] = 0
neutral_record["requiredEnergyWh"] = 0

neutral_record["energyType"] = None
neutral_record["askPriceMicrousdPerKwh"] = None
neutral_record["maxPriceMicrousdPerKwh"] = None

validate_record(neutral_record)

print("PASS: NEUTRAL market role is valid")


# --------------------------------------------------
# 9. Test that invalid records are rejected
# --------------------------------------------------

invalid_record = deepcopy(records[0])

invalid_record["netEnergyWh"] = 9999

try:
    validate_record(invalid_record)
except ValueError:
    print("PASS: incorrect energy calculation rejected")
else:
    raise AssertionError(
        "Invalid energy calculation was accepted"
    )


invalid_price_record = deepcopy(records[0])

invalid_price_record["askPriceMicrousdPerKwh"] = None

try:
    validate_record(invalid_price_record)
except ValueError:
    print("PASS: missing seller price rejected")
else:
    raise AssertionError(
        "Seller without an asking price was accepted"
    )


# --------------------------------------------------
# 10. Final result
# --------------------------------------------------

print("PASS: hourly energy record validation complete")
