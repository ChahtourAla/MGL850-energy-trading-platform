
"""
Tests for off-chain energy delivery simulation.
"""

import json

from pathlib import Path

import pytest

from jsonschema import (
    Draft202012Validator,
    FormatChecker,
)

from pydantic import ValidationError

from referencing import (
    Registry,
    Resource,
)

from p2p_energy_shared import (
    DeliveryRecord,
    DeliveryStatus,
)

from data_generator.delivery_simulator import (
    ActiveTrade,
    DeliveryScenario,
    simulate_delivery,
)


ROOT = Path(__file__).resolve().parents[3]

SCHEMAS = (
    ROOT / "packages" / "shared" / "schemas"
)


# --------------------------------------------------
# 1. Example active trade
# --------------------------------------------------

@pytest.fixture
def trade_data():

    return {
        "tradeId": (
            "88888888-8888-4888-8888-888888888888"
        ),
        "onChainTradeId": 999,
        "sellerId": (
            "11111111-1111-4111-8111-111111111111"
        ),
        "buyerId": (
            "22222222-2222-4222-8222-222222222222"
        ),
        "expectedWh": 4000,
        "deliveryStart": "2026-10-18T14:00:00Z",
        "deliveryDeadline": "2026-10-18T15:00:00Z",
        "status": "AWAITING_DELIVERY",
    }


@pytest.fixture
def trade(trade_data):

    return ActiveTrade.model_validate(
        trade_data
    )


# --------------------------------------------------
# TEST 1 — Accept a valid active trade
# --------------------------------------------------

def test_accepts_active_trade(trade):

    assert trade.expected_wh == 4000
    assert trade.on_chain_trade_id == 999


# --------------------------------------------------
# TEST 2 — Reject invalid active trades
# --------------------------------------------------

@pytest.mark.parametrize(
    "changes",
    [
        {"status": "CREATED"},
        {"status": "COMPLETED"},
        {"expectedWh": 0},
        {"onChainTradeId": 0},
        {"onChainTradeId": True},
        {
            "buyerId":
            "11111111-1111-4111-8111-111111111111"
        },
        {
            "deliveryDeadline":
            "2026-10-18T14:00:00Z"
        },
        {
            "deliveryDeadline":
            "2026-10-18T13:00:00Z"
        },
        {
            "deliveryStart":
            "2026-10-18T14:00:00+01:00"
        },
        {
            "deliveryStart":
            "not-a-timestamp"
        },
    ],
)
def test_rejects_invalid_active_trade(
    trade_data,
    changes,
):

    with pytest.raises(ValidationError):

        ActiveTrade.model_validate({
            **trade_data,
            **changes,
        })


# --------------------------------------------------
# TEST 3 — Successful delivery
# --------------------------------------------------

def test_success_record_uses_shared_contract(
    trade,
):

    record = simulate_delivery(
        trade,
        DeliveryScenario.SUCCESS,
    )

    assert isinstance(
        record,
        DeliveryRecord,
    )

    assert record.status == DeliveryStatus.SUCCESS

    assert record.expected_wh == 4000
    assert record.delivered_wh == 4000

    assert record.time_slot == trade.delivery_start

    assert record.trade_id == trade.trade_id
    assert record.seller_id == trade.seller_id
    assert record.buyer_id == trade.buyer_id

    assert (
        record.on_chain_trade_id
        == trade.on_chain_trade_id
    )

    assert record.evidence_hash is None


# --------------------------------------------------
# TEST 4 — Successful delivery can exceed expected
# --------------------------------------------------

def test_success_accepts_full_or_extra_delivery(
    trade,
):

    record = simulate_delivery(
        trade,
        DeliveryScenario.SUCCESS,
        delivered_wh=4200,
    )

    assert record.delivered_wh == 4200


# --------------------------------------------------
# TEST 5 — Reject insufficient successful delivery
# --------------------------------------------------

def test_success_rejects_short_delivery(trade):

    with pytest.raises(
        ValueError,
        match="SUCCESS requires",
    ):

        simulate_delivery(
            trade,
            DeliveryScenario.SUCCESS,
            delivered_wh=3999,
        )


# --------------------------------------------------
# TEST 6 — Incomplete delivery defaults to half
# --------------------------------------------------

def test_incomplete_delivery_defaults_to_half(
    trade,
):

    record = simulate_delivery(
        trade,
        DeliveryScenario.INCOMPLETE,
    )

    assert (
        record.status
        == DeliveryStatus.INCOMPLETE
    )

    assert record.delivered_wh == 2000


# --------------------------------------------------
# TEST 7 — Incomplete delivery may be zero
# --------------------------------------------------

def test_incomplete_can_report_zero(trade):

    record = simulate_delivery(
        trade,
        DeliveryScenario.INCOMPLETE,
        delivered_wh=0,
    )

    assert record.delivered_wh == 0


# --------------------------------------------------
# TEST 8 — Reject complete quantity in incomplete
# --------------------------------------------------

def test_incomplete_rejects_full_delivery(
    trade,
):

    with pytest.raises(
        ValueError,
        match="INCOMPLETE requires",
    ):

        simulate_delivery(
            trade,
            DeliveryScenario.INCOMPLETE,
            delivered_wh=4000,
        )


# --------------------------------------------------
# TEST 9 — Missing delivery means no record
# --------------------------------------------------

def test_missing_returns_no_delivery_record(
    trade,
):

    result = simulate_delivery(
        trade,
        DeliveryScenario.MISSING,
    )

    assert result is None


# --------------------------------------------------
# TEST 10 — Missing cannot have measurements
# --------------------------------------------------

@pytest.mark.parametrize(
    "options",
    [
        {"delivered_wh": 0},
        {
            "reported_at":
            "2026-10-18T14:05:00Z"
        },
    ],
)
def test_missing_rejects_measurements(
    trade,
    options,
):

    with pytest.raises(
        ValueError,
        match="MISSING cannot",
    ):

        simulate_delivery(
            trade,
            DeliveryScenario.MISSING,
            **options,
        )


# --------------------------------------------------
# TEST 11 — Invalid delivery happens after deadline
# --------------------------------------------------

def test_invalid_is_late_but_schema_valid(trade):

    record = simulate_delivery(
        trade,
        DeliveryScenario.INVALID,
    )

    assert record.status == DeliveryStatus.INVALID

    assert record.delivered_wh == trade.expected_wh

    assert (
        record.time_slot
        == "2026-10-18T15:00:01Z"
    )

    assert (
        record.time_slot
        > trade.delivery_deadline
    )


# --------------------------------------------------
# TEST 12 — Invalid must be outside delivery window
# --------------------------------------------------

def test_invalid_rejects_in_window_time(trade):

    with pytest.raises(
        ValueError,
        match="INVALID scenario",
    ):

        simulate_delivery(
            trade,
            DeliveryScenario.INVALID,
            reported_at="2026-10-18T14:30:00Z",
        )


# --------------------------------------------------
# TEST 13 — Valid deliveries need valid timestamps
# --------------------------------------------------

def test_valid_scenarios_require_time_inside_window(
    trade,
):

    with pytest.raises(
        ValueError,
        match="inside the delivery window",
    ):

        simulate_delivery(
            trade,
            DeliveryScenario.SUCCESS,
            reported_at="2026-10-18T15:00:01Z",
        )


# --------------------------------------------------
# TEST 14 — Support custom reporting timestamps
# --------------------------------------------------

def test_can_report_at_custom_time(trade):

    record = simulate_delivery(
        trade,
        DeliveryScenario.SUCCESS,
        reported_at="2026-10-18T14:30:00Z",
    )

    assert (
        record.time_slot
        == "2026-10-18T14:30:00Z"
    )


# --------------------------------------------------
# TEST 15 — Reject invalid delivered quantities
# --------------------------------------------------

@pytest.mark.parametrize(
    "value",
    [-1, True, 1.5, "1000"],
)
def test_rejects_invalid_delivery_quantity(
    trade,
    value,
):

    with pytest.raises(
        (TypeError, ValueError)
    ):

        simulate_delivery(
            trade,
            DeliveryScenario.SUCCESS,
            delivered_wh=value,
        )


# --------------------------------------------------
# TEST 16 — Reject wrong input object types
# --------------------------------------------------

def test_rejects_wrong_input_types(trade):

    with pytest.raises(
        TypeError,
        match="ActiveTrade",
    ):

        simulate_delivery(
            {},
            DeliveryScenario.SUCCESS,
        )

    with pytest.raises(
        TypeError,
        match="DeliveryScenario",
    ):

        simulate_delivery(
            trade,
            "SUCCESS",
        )


# --------------------------------------------------
# TEST 17 — Delivery IDs are deterministic
# --------------------------------------------------

def test_delivery_ids_are_deterministic(trade):

    first = simulate_delivery(
        trade,
        DeliveryScenario.SUCCESS,
    )

    second = simulate_delivery(
        trade,
        DeliveryScenario.SUCCESS,
    )

    assert first == second

    assert (
        first.delivery_id
        == second.delivery_id
    )


# --------------------------------------------------
# TEST 18 — Different scenarios have different IDs
# --------------------------------------------------

def test_different_scenarios_have_different_ids(
    trade,
):

    first = simulate_delivery(
        trade,
        DeliveryScenario.SUCCESS,
    )

    second = simulate_delivery(
        trade,
        DeliveryScenario.INCOMPLETE,
    )

    assert (
        first.delivery_id
        != second.delivery_id
    )


# --------------------------------------------------
# TEST 19 — Simulation cannot modify its input
# --------------------------------------------------

def test_input_is_not_modified(trade):

    before = trade.model_dump_json(
        by_alias=True
    )

    simulate_delivery(
        trade,
        DeliveryScenario.SUCCESS,
    )

    assert (
        trade.model_dump_json(by_alias=True)
        == before
    )


# --------------------------------------------------
# TEST 20 — JSON serialization and validation
# --------------------------------------------------

def test_delivery_json_round_trip(trade):

    record = simulate_delivery(
        trade,
        DeliveryScenario.SUCCESS,
    )

    serialized = record.model_dump_json(
        by_alias=True,
        exclude_none=True,
    )

    parsed = DeliveryRecord.model_validate_json(
        serialized
    )

    assert parsed == record


# --------------------------------------------------
# TEST 21 — Existing JSON Schema compatibility
# --------------------------------------------------

def test_delivery_follows_existing_json_schema(
    trade,
):

    record = simulate_delivery(
        trade,
        DeliveryScenario.INVALID,
    )

    registry = Registry()

    for path in sorted(
        SCHEMAS.glob("*.schema.json")
    ):

        schema = json.loads(
            path.read_text(encoding="utf-8")
        )

        registry = registry.with_resource(
            schema["$id"],
            Resource.from_contents(schema),
        )

    target = json.loads(
        (
            SCHEMAS / "delivery-record.schema.json"
        ).read_text(encoding="utf-8")
    )

    validator = Draft202012Validator(
        target,
        registry=registry,
        format_checker=FormatChecker(),
    )

    validator.validate(
        record.model_dump(
            mode="json",
            by_alias=True,
            exclude_none=True,
        )
    )
