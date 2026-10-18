
import json
from copy import deepcopy
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator, FormatChecker
from pydantic import ValidationError
from referencing import Registry, Resource

from p2p_energy_shared import DeliveryRecord, DeliveryStatus


SHARED_DIR = Path(__file__).resolve().parents[2]
FIXTURES = SHARED_DIR / "fixtures"
SCHEMAS = SHARED_DIR / "schemas"


def load_fixture(filename):
    return json.loads(
        (FIXTURES / filename).read_text(encoding="utf-8")
    )


@pytest.fixture
def delivery_data():
    return load_fixture("delivery-record.sample.json")


# --------------------------------------------------
# TEST 1 — Load existing delivery fixture
# --------------------------------------------------

def test_loads_delivery_fixture(delivery_data):
    record = DeliveryRecord.model_validate(delivery_data)

    assert record.expected_wh == 4000
    assert record.delivered_wh == 4000
    assert record.status == DeliveryStatus.SUCCESS
    assert record.on_chain_trade_id == 999


# --------------------------------------------------
# TEST 2 — JSON round trip
# --------------------------------------------------

def test_json_round_trip(delivery_data):
    record = DeliveryRecord.model_validate(delivery_data)

    result = record.model_dump(
        mode="json",
        by_alias=True,
        exclude_none=True,
    )

    assert result == delivery_data


# --------------------------------------------------
# TEST 3 — Match existing JSON Schema
# --------------------------------------------------

def test_matches_json_schema(delivery_data):
    registry = Registry()

    for filename in [
        "common.schema.json",
        "delivery-record.schema.json",
    ]:
        schema = json.loads(
            (SCHEMAS / filename).read_text(
                encoding="utf-8"
            )
        )

        registry = registry.with_resource(
            schema["$id"],
            Resource.from_contents(schema),
        )

    delivery_schema = json.loads(
        (
            SCHEMAS / "delivery-record.schema.json"
        ).read_text(encoding="utf-8")
    )

    record = DeliveryRecord.model_validate(delivery_data)

    exported = record.model_dump(
        mode="json",
        by_alias=True,
        exclude_none=True,
    )

    validator = Draft202012Validator(
        delivery_schema,
        registry=registry,
        format_checker=FormatChecker(),
    )

    validator.validate(exported)


# --------------------------------------------------
# TEST 4 — Check matching fixture consistency
# --------------------------------------------------

def test_matches_matching_fixture(delivery_data):
    output = load_fixture("matching-output.sample.json")
    match = output["matches"][0]

    record = DeliveryRecord.model_validate(delivery_data)

    assert str(record.buyer_id) == match["buyerId"]
    assert str(record.seller_id) == match["sellerId"]
    assert record.expected_wh == match["quantityWh"]


# --------------------------------------------------
# TEST 5 — Accept all valid statuses
# --------------------------------------------------

@pytest.mark.parametrize(
    "status,delivered_wh",
    [
        ("PENDING", 0),
        ("SUCCESS", 4000),
        ("INCOMPLETE", 2500),
        ("INVALID", 1000),
        ("CONFIRMED", 4000),
    ],
)
def test_valid_statuses(
    delivery_data,
    status,
    delivered_wh,
):
    delivery_data["status"] = status
    delivery_data["deliveredWh"] = delivered_wh

    record = DeliveryRecord.model_validate(delivery_data)

    assert record.status.value == status


# --------------------------------------------------
# TEST 6 — Reject invalid fields
# --------------------------------------------------

@pytest.mark.parametrize(
    "field,value",
    [
        ("deliveredWh", -1),
        ("deliveredWh", "4000"),
        ("expectedWh", 0),
        ("onChainTradeId", 0),
        ("buyerId", "not-a-uuid"),
        ("status", "FINISHED"),
        ("evidenceHash", "0x1234"),
        ("timeSlot", "2026-02-30T14:30:00Z"),
        ("timeSlot", "2026-10-17T14:30:00+00:00"),
    ],
)
def test_rejects_invalid_fields(
    delivery_data,
    field,
    value,
):
    delivery_data[field] = value

    with pytest.raises(ValidationError):
        DeliveryRecord.model_validate(delivery_data)


# --------------------------------------------------
# TEST 7 — Reject SUCCESS with insufficient energy
# --------------------------------------------------

def test_rejects_successful_under_delivery(delivery_data):
    delivery_data["deliveredWh"] = 2000

    with pytest.raises(ValidationError):
        DeliveryRecord.model_validate(delivery_data)


# --------------------------------------------------
# TEST 8 — Reject insufficient CONFIRMED delivery
# --------------------------------------------------

def test_rejects_confirmed_under_delivery(delivery_data):
    delivery_data["status"] = "CONFIRMED"
    delivery_data["deliveredWh"] = 2000

    with pytest.raises(ValidationError):
        DeliveryRecord.model_validate(delivery_data)


# --------------------------------------------------
# TEST 9 — Reject INCOMPLETE with full delivery
# --------------------------------------------------

def test_rejects_incomplete_full_delivery(delivery_data):
    delivery_data["status"] = "INCOMPLETE"

    with pytest.raises(ValidationError):
        DeliveryRecord.model_validate(delivery_data)


# --------------------------------------------------
# TEST 10 — Reject PENDING with delivered energy
# --------------------------------------------------

def test_rejects_pending_with_energy(delivery_data):
    delivery_data["status"] = "PENDING"
    delivery_data["deliveredWh"] = 1000

    with pytest.raises(ValidationError):
        DeliveryRecord.model_validate(delivery_data)


# --------------------------------------------------
# TEST 11 — Reject buyer equal to seller
# --------------------------------------------------

def test_rejects_self_trade(delivery_data):
    delivery_data["buyerId"] = delivery_data["sellerId"]

    with pytest.raises(ValidationError):
        DeliveryRecord.model_validate(delivery_data)


# --------------------------------------------------
# TEST 12 — Reject explicit null evidence hash
# --------------------------------------------------

def test_rejects_null_evidence_hash(delivery_data):
    delivery_data["evidenceHash"] = None

    with pytest.raises(ValidationError):
        DeliveryRecord.model_validate(delivery_data)


# --------------------------------------------------
# TEST 13 — Reject unexpected fields
# --------------------------------------------------

def test_rejects_extra_field(delivery_data):
    delivery_data["unexpectedField"] = True

    with pytest.raises(ValidationError):
        DeliveryRecord.model_validate(delivery_data)
