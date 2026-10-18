
import json
import math
from copy import deepcopy
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource


# --------------------------------------------------
# 1. Locate directories
# --------------------------------------------------

shared_dir = Path(__file__).resolve().parents[1]

schema_dir = shared_dir / "schemas"
fixture_dir = shared_dir / "fixtures"


def load_json(path: Path):
    return json.loads(
        path.read_text(encoding="utf-8")
    )


# --------------------------------------------------
# 2. Register schemas
# --------------------------------------------------

schema_names = [
    "common.schema.json",
    "hourly-energy-record.schema.json",
    "energy-snapshot.schema.json",
    "matching-config.schema.json",
    "matching-input.schema.json",
]

registry = Registry()

for name in schema_names:
    schema = load_json(schema_dir / name)

    Draft202012Validator.check_schema(schema)

    registry = registry.with_resource(
        schema["$id"],
        Resource.from_contents(schema)
    )


def make_validator(name):
    return Draft202012Validator(
        load_json(schema_dir / name),
        registry=registry,
        format_checker=FormatChecker()
    )


config_validator = make_validator(
    "matching-config.schema.json"
)

input_validator = make_validator(
    "matching-input.schema.json"
)

snapshot_validator = make_validator(
    "energy-snapshot.schema.json"
)


# --------------------------------------------------
# 3. Helper for schema validation
# --------------------------------------------------

def check_schema(validator, data, label):

    errors = list(validator.iter_errors(data))

    if errors:
        raise ValueError(
            f"Invalid {label}: {errors[0].message}"
        )


# --------------------------------------------------
# 4. Validate configuration + matching input
# --------------------------------------------------

def validate_matching_input(
    matching_input,
    config,
    snapshot
):

    check_schema(
        config_validator,
        config,
        "matching configuration"
    )

    check_schema(
        snapshot_validator,
        snapshot,
        "energy snapshot"
    )

    check_schema(
        input_validator,
        matching_input,
        "matching input"
    )

    # All files must use the same schema version.
    if not (
        matching_input["schemaVersion"]
        == config["schemaVersion"]
        == snapshot["schemaVersion"]
    ):
        raise ValueError(
            "Schema versions do not match"
        )

    # The matching input must refer to
    # the correct energy snapshot.
    if (
        matching_input["snapshotId"]
        != snapshot["snapshotId"]
    ):
        raise ValueError(
            "Incorrect snapshotId"
        )

    if (
        matching_input["timeSlot"]
        != snapshot["timeSlot"]
    ):
        raise ValueError(
            "Incorrect timeSlot"
        )

    # Check matching configuration.
    if (
        matching_input["algorithmVersion"]
        != config["algorithmVersion"]
    ):
        raise ValueError(
            "Incorrect algorithmVersion"
        )

    if (
        matching_input["maximumDistanceKm"]
        != config["maximumDistanceKm"]
    ):
        raise ValueError(
            "Incorrect maximumDistanceKm"
        )

    if (
        matching_input["scoringWeights"]
        != config["scoringWeights"]
    ):
        raise ValueError(
            "Scoring weights differ from configuration"
        )

    # The weights must sum to 1.0.
    weights = config["scoringWeights"]

    total_weight = sum(weights.values())

    if not math.isclose(
        total_weight,
        1.0,
        rel_tol=0,
        abs_tol=1e-9
    ):
        raise ValueError(
            "Scoring weights must sum to 1.0"
        )

    # The input must contain exactly the
    # validated records from the snapshot.
    if matching_input["users"] != snapshot["users"]:
        raise ValueError(
            "Matching users differ from energy snapshot"
        )

    # Check that all records use the same hour.
    for record in matching_input["users"]:
        if (
            record["timeSlot"]
            != matching_input["timeSlot"]
        ):
            raise ValueError(
                "User record has incorrect timeSlot"
            )

    # No user may appear more than once.
    user_ids = [
        user["userId"]
        for user in matching_input["users"]
    ]

    if len(user_ids) != len(set(user_ids)):
        raise ValueError(
            "Duplicate userId in matching input"
        )

    record_ids = [
        user["recordId"]
        for user in matching_input["users"]
    ]

    if len(record_ids) != len(set(record_ids)):
        raise ValueError(
            "Duplicate recordId in matching input"
        )

    # Verify the energy arithmetic.
    for record in matching_input["users"]:

        net = (
            record["productionWh"]
            - record["consumptionWh"]
        )

        if record["netEnergyWh"] != net:
            raise ValueError(
                "Incorrect energy calculation"
            )

        expected_role = (
            "SELLER" if net > 0
            else "BUYER" if net < 0
            else "NEUTRAL"
        )

        if record["marketRole"] != expected_role:
            raise ValueError(
                "Incorrect market role"
            )

        if record["availableEnergyWh"] != max(net, 0):
            raise ValueError(
                "Incorrect available energy"
            )

        if record["requiredEnergyWh"] != max(-net, 0):
            raise ValueError(
                "Incorrect required energy"
            )


# --------------------------------------------------
# 5. Load fixtures
# --------------------------------------------------

config = load_json(
    fixture_dir / "matching-config.sample.json"
)

matching_input = load_json(
    fixture_dir / "matching-input.sample.json"
)

snapshot = load_json(
    fixture_dir / "energy-snapshot.sample.json"
)


# --------------------------------------------------
# 6. Validate the valid examples
# --------------------------------------------------

validate_matching_input(
    matching_input,
    config,
    snapshot
)

print("PASS: MatchingConfig schema is valid")
print("PASS: MatchingInput schema is valid")
print("PASS: scoring weights sum to 1.0")
print("PASS: matching input agrees with snapshot")
print("PASS: matching configuration is consistent")
print("PASS: user records and energy calculations are valid")


# --------------------------------------------------
# 7. Negative test helper
# --------------------------------------------------

def expect_rejection(
    test_input,
    test_config,
    label
):
    try:
        validate_matching_input(
            test_input,
            test_config,
            snapshot
        )
    except ValueError:
        print(f"PASS: rejected {label}")
    else:
        raise AssertionError(
            f"Invalid data accepted: {label}"
        )


# --------------------------------------------------
# 8. Test invalid cases
# --------------------------------------------------

# Invalid case 1: zero maximum distance
bad_config = deepcopy(config)
bad_config["maximumDistanceKm"] = 0

expect_rejection(
    matching_input,
    bad_config,
    "zero maximum distance"
)


# Invalid case 2: weights do not sum to 1.0
bad_config = deepcopy(config)
bad_input = deepcopy(matching_input)

bad_config["scoringWeights"]["quantity"] = 0.20
bad_input["scoringWeights"]["quantity"] = 0.20

expect_rejection(
    bad_input,
    bad_config,
    "incorrect weight total"
)


# Invalid case 3: wrong snapshot ID
bad_input = deepcopy(matching_input)

bad_input["snapshotId"] = (
    "99999999-9999-4999-8999-999999999999"
)

expect_rejection(
    bad_input,
    config,
    "incorrect snapshot ID"
)


# Invalid case 4: different algorithm version
bad_input = deepcopy(matching_input)

bad_input["algorithmVersion"] = "2.0.0"

expect_rejection(
    bad_input,
    config,
    "incorrect algorithm version"
)


# Invalid case 5: wrong user time slot
bad_input = deepcopy(matching_input)

bad_input["users"][0]["timeSlot"] = (
    "2026-10-17T15:00:00Z"
)

expect_rejection(
    bad_input,
    config,
    "incorrect user time slot"
)


# Invalid case 6: duplicate user
bad_input = deepcopy(matching_input)

bad_input["users"][1]["userId"] = (
    bad_input["users"][0]["userId"]
)

expect_rejection(
    bad_input,
    config,
    "duplicate user"
)


# --------------------------------------------------
# 9. Final success
# --------------------------------------------------

print("\nPASS: Matching input validation complete")
