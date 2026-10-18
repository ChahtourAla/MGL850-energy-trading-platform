
import json
from copy import deepcopy
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource


# --------------------------------------------------
# 1. Define paths
# --------------------------------------------------

shared_dir = Path(__file__).resolve().parents[1]

schema_dir = shared_dir / "schemas"
fixture_dir = shared_dir / "fixtures"


def load_json(path: Path):
    return json.loads(
        path.read_text(encoding="utf-8")
    )


# --------------------------------------------------
# 2. Register JSON schemas
# --------------------------------------------------

schema_names = [
    "common.schema.json",
    "hourly-energy-record.schema.json",
    "energy-snapshot.schema.json",
]

registry = Registry()

for name in schema_names:

    schema = load_json(schema_dir / name)

    Draft202012Validator.check_schema(schema)

    registry = registry.with_resource(
        schema["$id"],
        Resource.from_contents(schema)
    )


snapshot_schema = load_json(
    schema_dir / "energy-snapshot.schema.json"
)

validator = Draft202012Validator(
    snapshot_schema,
    registry=registry,
    format_checker=FormatChecker()
)


# --------------------------------------------------
# 3. Load canonical user registry
# --------------------------------------------------

user_registry = load_json(
    fixture_dir / "user-registry.sample.json"
)

registered_users = {
    user["userId"]: user
    for user in user_registry["users"]
}


# --------------------------------------------------
# 4. Validate a complete snapshot
# --------------------------------------------------

def validate_snapshot(snapshot):

    # Check JSON Schema rules.
    errors = list(
        validator.iter_errors(snapshot)
    )

    if errors:
        raise ValueError(
            f"Invalid snapshot schema: {errors[0].message}"
        )

    # All active users must have one hourly record.
    records = snapshot["users"]

    if len(records) != len(registered_users):
        raise ValueError(
            "Incorrect number of hourly records"
        )

    seen_users = set()
    seen_records = set()

    for record in records:

        user_id = record["userId"]
        record_id = record["recordId"]

        # Check that the user exists.
        if user_id not in registered_users:
            raise ValueError(
                f"Unknown user: {user_id}"
            )

        # No duplicate records or users.
        if user_id in seen_users:
            raise ValueError(
                f"Duplicate user: {user_id}"
            )

        if record_id in seen_records:
            raise ValueError(
                f"Duplicate record: {record_id}"
            )

        seen_users.add(user_id)
        seen_records.add(record_id)

        # Every record belongs to the snapshot hour.
        if record["timeSlot"] != snapshot["timeSlot"]:
            raise ValueError(
                f"Incorrect timeSlot for user {user_id}"
            )

        # Verify energy arithmetic.
        expected_net = (
            record["productionWh"]
            - record["consumptionWh"]
        )

        if record["netEnergyWh"] != expected_net:
            raise ValueError(
                f"Incorrect netEnergyWh for user {user_id}"
            )

        # Verify market classification.
        if expected_net > 0:
            expected_role = "SELLER"
        elif expected_net < 0:
            expected_role = "BUYER"
        else:
            expected_role = "NEUTRAL"

        if record["marketRole"] != expected_role:
            raise ValueError(
                f"Incorrect marketRole for user {user_id}"
            )

        # Verify available and required energy.
        if record["availableEnergyWh"] != max(expected_net, 0):
            raise ValueError(
                f"Incorrect availableEnergyWh for {user_id}"
            )

        if record["requiredEnergyWh"] != max(-expected_net, 0):
            raise ValueError(
                f"Incorrect requiredEnergyWh for {user_id}"
            )

        # Verify copied user profile fields.
        profile = registered_users[user_id]

        profile_fields = [
            "xKm",
            "yKm",
            "reputation",
            "preferredEnergyType",
        ]

        for field in profile_fields:
            if record[field] != profile[field]:
                raise ValueError(
                    f"Incorrect {field} for user {user_id}"
                )

        # If the registry includes a wallet address,
        # it must agree with the energy record.
        if "evmAddress" in profile:
            if (
                record["evmAddress"].lower()
                != profile["evmAddress"].lower()
            ):
                raise ValueError(
                    f"Incorrect evmAddress for {user_id}"
                )

    # Confirm every registered user appears once.
    if seen_users != set(registered_users):
        raise ValueError(
            "Snapshot is missing registered users"
        )


# --------------------------------------------------
# 5. Validate the example snapshot
# --------------------------------------------------

snapshot = load_json(
    fixture_dir / "energy-snapshot.sample.json"
)

validate_snapshot(snapshot)

print("PASS: EnergySnapshot schema is valid")

print(
    f"PASS: snapshot contains {len(snapshot['users'])} records"
)

print("PASS: all records use the snapshot hour")

print("PASS: all registered users appear exactly once")

print(
    "PASS: profile fields and energy calculations are consistent"
)


# --------------------------------------------------
# 6. Compare with the Step 2.2 example records
# --------------------------------------------------

hourly_records = load_json(
    fixture_dir / "hourly-energy-records.sample.json"
)

if snapshot["users"] != hourly_records:
    raise ValueError(
        "Snapshot records differ from Step 2.2 fixture"
    )

print("PASS: snapshot matches Step 2.2 records")


# --------------------------------------------------
# 7. Test invalid snapshot cases
# --------------------------------------------------

def expect_rejection(invalid_snapshot, name):
    try:
        validate_snapshot(invalid_snapshot)
    except ValueError:
        print(f"PASS: rejected {name}")
    else:
        raise AssertionError(
            f"Invalid snapshot accepted: {name}"
        )


# Case 1: wrong time slot
wrong_time = deepcopy(snapshot)

wrong_time["users"][0]["timeSlot"] = (
    "2026-10-17T15:00:00Z"
)

expect_rejection(
    wrong_time,
    "different user timeSlot"
)


# Case 2: duplicate user
duplicate_user = deepcopy(snapshot)

duplicate_user["users"][1]["userId"] = (
    duplicate_user["users"][0]["userId"]
)

expect_rejection(
    duplicate_user,
    "duplicate user"
)


# Case 3: incorrect energy calculation
wrong_energy = deepcopy(snapshot)

wrong_energy["users"][0]["netEnergyWh"] = 9999

expect_rejection(
    wrong_energy,
    "incorrect energy calculation"
)


# Case 4: missing user
missing_user = deepcopy(snapshot)

missing_user["users"].pop()

expect_rejection(
    missing_user,
    "missing user"
)


# Case 5: invalid version format
wrong_version = deepcopy(snapshot)

wrong_version["generatorVersion"] = "invalid"

expect_rejection(
    wrong_version,
    "invalid generator version"
)


# Case 6: unknown user
unknown_user = deepcopy(snapshot)

unknown_user["users"][1]["userId"] = (
    "99999999-9999-4999-8999-999999999999"
)

expect_rejection(
    unknown_user,
    "unknown user"
)


# --------------------------------------------------
# 8. Final success
# --------------------------------------------------

print("\nPASS: EnergySnapshot validation complete")
