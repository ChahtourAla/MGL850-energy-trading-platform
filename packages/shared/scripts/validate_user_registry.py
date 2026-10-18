import json
import sys
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource


# --------------------------------------------------
# 1. Locate shared directories
# --------------------------------------------------

shared_dir = Path(__file__).resolve().parents[1]

schema_dir = shared_dir / "schemas"

fixture_path = (
    shared_dir
    / "fixtures"
    / "user-registry.sample.json"
)


# --------------------------------------------------
# 2. Helper for reading JSON files
# --------------------------------------------------

def load_json(path: Path):
    return json.loads(
        path.read_text(encoding="utf-8")
    )


# --------------------------------------------------
# 3. Register all three schemas
# --------------------------------------------------

registry = Registry()

schema_names = [
    "common.schema.json",
    "user.schema.json",
    "user-registry.schema.json",
]

for name in schema_names:

    schema = load_json(
        schema_dir / name
    )

    # Verify that the schema itself is valid.
    Draft202012Validator.check_schema(schema)

    # Allow $ref to find schemas locally.
    registry = registry.with_resource(
        schema["$id"],
        Resource.from_contents(schema)
    )


# --------------------------------------------------
# 4. Prepare the validator
# --------------------------------------------------

validator = Draft202012Validator(
    load_json(
        schema_dir / "user-registry.schema.json"
    ),
    registry=registry,
    format_checker=FormatChecker(),
)


# --------------------------------------------------
# 5. Validate the example registry
# --------------------------------------------------

data = load_json(fixture_path)

errors = list(
    validator.iter_errors(data)
)

if errors:

    for error in errors:
        print(
            f"FAIL at {list(error.absolute_path)}: "
            f"{error.message}",
            file=sys.stderr
        )

    raise SystemExit(1)


# --------------------------------------------------
# 6. Check unique user IDs and emails
# --------------------------------------------------

user_ids = [
    user["userId"]
    for user in data["users"]
]

emails = [
    user["email"].lower()
    for user in data["users"]
]

if (
    len(user_ids) != len(set(user_ids))
    or len(emails) != len(set(emails))
):
    raise SystemExit(
        "FAIL: duplicate userId or email"
    )


# --------------------------------------------------
# 7. Display results
# --------------------------------------------------

print("PASS: 3 schemas are valid")

print(
    f"PASS: user registry contains "
    f"{len(data['users'])} valid users"
)

print(
    "PASS: user IDs and emails are unique"
)