
import json
from copy import deepcopy
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource


# --------------------------------------------------
# 1. Locate shared files
# --------------------------------------------------

shared_dir = Path(__file__).resolve().parents[1]

schema_dir = shared_dir / "schemas"
fixture_dir = shared_dir / "fixtures"


def load_json(path: Path):
    return json.loads(
        path.read_text(encoding="utf-8")
    )


# --------------------------------------------------
# 2. Register the JSON Schemas
# --------------------------------------------------

schema_names = [
    "common.schema.json",
    "delivery-record.schema.json",
]

registry = Registry()

for name in schema_names:

    schema = load_json(schema_dir / name)

    Draft202012Validator.check_schema(schema)

    registry = registry.with_resource(
        schema["$id"],
        Resource.from_contents(schema)
    )


delivery_schema = load_json(
    schema_dir / "delivery-record.schema.json"
)

validator = Draft202012Validator(
    delivery_schema,
    registry=registry,
    format_checker=FormatChecker()
)


# --------------------------------------------------
# 3. Validate one delivery record
# --------------------------------------------------

def validate_delivery_record(record):

    errors = list(validator.iter_errors(record))

    if errors:
        raise ValueError(
            f"Invalid DeliveryRecord: {errors[0].message}"
        )

    # Buyer and seller must be different users.
    if record["buyerId"] == record["sellerId"]:
        raise ValueError(
            "Buyer and seller cannot be the same user"
        )

    expected = record["expectedWh"]
    delivered = record["deliveredWh"]
    status = record["status"]

    # A successful delivery must meet
    # the agreed energy quantity.
    if status in ("SUCCESS", "CONFIRMED"):
        if delivered < expected:
            raise ValueError(
                "Successful delivery is below expected energy"
            )

    # An incomplete delivery must be
    # smaller than the expected amount.
    if status == "INCOMPLETE":
        if delivered >= expected:
            raise ValueError(
                "Incomplete delivery must be below expected energy"
            )

    # In this prototype, PENDING means
    # no energy has been reported yet.
    if status == "PENDING":
        if delivered != 0:
            raise ValueError(
                "Pending delivery must have deliveredWh = 0"
            )


# --------------------------------------------------
# 4. Validate a collection of delivery records
# --------------------------------------------------

def validate_delivery_records(records):

    seen_delivery_ids = set()
    confirmed_trades = set()

    for record in records:

        validate_delivery_record(record)

        delivery_id = record["deliveryId"]

        if delivery_id in seen_delivery_ids:
            raise ValueError(
                "Duplicate deliveryId"
            )

        seen_delivery_ids.add(delivery_id)

        # Do not allow duplicate confirmed
        # records for the same trade and time.
        if record["status"] == "CONFIRMED":

            key = (
                record["tradeId"],
                record["timeSlot"]
            )

            if key in confirmed_trades:
                raise ValueError(
                    "Duplicate confirmed delivery"
                )

            confirmed_trades.add(key)


# --------------------------------------------------
# 5. Load the example record
# --------------------------------------------------

delivery = load_json(
    fixture_dir / "delivery-record.sample.json"
)

validate_delivery_record(delivery)

print("PASS: DeliveryRecord schema is valid")
print("PASS: successful delivery is valid")


# --------------------------------------------------
# 6. Check consistency with the matching result
# --------------------------------------------------

matching_output = load_json(
    fixture_dir / "matching-output.sample.json"
)

match = matching_output["matches"][0]

if delivery["buyerId"] != match["buyerId"]:
    raise ValueError(
        "Delivery buyer does not match the trade"
    )

if delivery["sellerId"] != match["sellerId"]:
    raise ValueError(
        "Delivery seller does not match the trade"
    )

if delivery["expectedWh"] != match["quantityWh"]:
    raise ValueError(
        "Expected delivery differs from matched quantity"
    )

print("PASS: delivery agrees with matching fixture")


# --------------------------------------------------
# 7. Test other valid delivery statuses
# --------------------------------------------------

incomplete = deepcopy(delivery)
incomplete["status"] = "INCOMPLETE"
incomplete["deliveredWh"] = 2500

validate_delivery_record(incomplete)

print("PASS: incomplete delivery is valid")


pending = deepcopy(delivery)
pending["status"] = "PENDING"
pending["deliveredWh"] = 0

validate_delivery_record(pending)

print("PASS: pending delivery is valid")


invalid = deepcopy(delivery)
invalid["status"] = "INVALID"

validate_delivery_record(invalid)

print("PASS: invalid-status record is structurally valid")


confirmed = deepcopy(delivery)
confirmed["status"] = "CONFIRMED"
confirmed["evidenceHash"] = "0x" + "a1" * 32

validate_delivery_record(confirmed)

print("PASS: confirmed delivery record is valid")


# --------------------------------------------------
# 8. Helper to test incorrect records
# --------------------------------------------------

def expect_rejection(record, label):

    try:
        validate_delivery_record(record)

    except ValueError:
        print(f"PASS: rejected {label}")

    else:
        raise AssertionError(
            f"Invalid record accepted: {label}"
        )


# --------------------------------------------------
# 9. Test invalid records
# --------------------------------------------------

# Invalid case 1: negative delivered quantity
bad = deepcopy(delivery)
bad["deliveredWh"] = -100

expect_rejection(
    bad,
    "negative delivered energy"
)


# Invalid case 2: success with insufficient energy
bad = deepcopy(delivery)
bad["deliveredWh"] = 2500

expect_rejection(
    bad,
    "successful under-delivery"
)


# Invalid case 3: incomplete with full delivery
bad = deepcopy(delivery)
bad["status"] = "INCOMPLETE"

expect_rejection(
    bad,
    "incomplete status with full delivery"
)


# Invalid case 4: buyer equals seller
bad = deepcopy(delivery)
bad["buyerId"] = bad["sellerId"]

expect_rejection(
    bad,
    "buyer and seller are the same user"
)


# Invalid case 5: unknown delivery status
bad = deepcopy(delivery)
bad["status"] = "FINISHED"

expect_rejection(
    bad,
    "unknown delivery status"
)


# Invalid case 6: invalid on-chain trade ID
bad = deepcopy(delivery)
bad["onChainTradeId"] = 0

expect_rejection(
    bad,
    "invalid on-chain trade ID"
)


# Invalid case 7: invalid UTC timestamp
bad = deepcopy(delivery)
bad["timeSlot"] = "not-a-date"

expect_rejection(
    bad,
    "invalid UTC timestamp"
)


# Invalid case 8: malformed evidence hash
bad = deepcopy(delivery)
bad["evidenceHash"] = "0x1234"

expect_rejection(
    bad,
    "invalid evidence hash"
)


# --------------------------------------------------
# 10. Test duplicate delivery records
# --------------------------------------------------

try:
    validate_delivery_records([
        delivery,
        deepcopy(delivery)
    ])

except ValueError:
    print("PASS: rejected duplicate deliveryId")

else:
    raise AssertionError(
        "Duplicate deliveryId was accepted"
    )


# --------------------------------------------------
# 11. Test missing-delivery scenario
# --------------------------------------------------

# No record produced represents a missing delivery.
validate_delivery_records([])

print("PASS: missing delivery can be represented")


# --------------------------------------------------
# 12. Final result
# --------------------------------------------------

print("\nPASS: DeliveryRecord validation complete")
