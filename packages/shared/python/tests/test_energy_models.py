
import json
from copy import deepcopy
from pathlib import Path

import pytest
from pydantic import ValidationError

from p2p_energy_shared import (
    EnergySnapshot,
    HourlyEnergyRecord,
    EnergyType,
    MarketRole,
)


SAMPLE = (
    Path(__file__).resolve().parents[2]
    / "fixtures"
    / "energy-snapshot.sample.json"
)


# --------------------------------------------------
# 1. Load our existing EnergySnapshot fixture
# --------------------------------------------------

@pytest.fixture
def snapshot_data():
    return json.loads(
        SAMPLE.read_text(encoding="utf-8")
    )


# --------------------------------------------------
# TEST 1 — Read the existing snapshot
# --------------------------------------------------

def test_snapshot_loads_existing_fixture(snapshot_data):

    snapshot = EnergySnapshot.model_validate(
        snapshot_data
    )

    assert len(snapshot.users) == 2

    seller = snapshot.users[0]
    buyer = snapshot.users[1]

    assert seller.market_role == MarketRole.SELLER
    assert seller.energy_type == EnergyType.SOLAR
    assert seller.available_energy_wh == 4000

    assert buyer.market_role == MarketRole.BUYER
    assert buyer.required_energy_wh == 4000


# --------------------------------------------------
# TEST 2 — Convert Python models back to JSON
# --------------------------------------------------

def test_snapshot_json_round_trip(snapshot_data):

    snapshot = EnergySnapshot.model_validate(
        snapshot_data
    )

    result = snapshot.model_dump(
        mode="json",
        by_alias=True
    )

    assert result == snapshot_data


# --------------------------------------------------
# TEST 3 — Validate a NEUTRAL user
# --------------------------------------------------

def test_neutral_record(snapshot_data):

    neutral = deepcopy(snapshot_data["users"][0])

    neutral.update({
        "productionWh": 2000,
        "consumptionWh": 2000,
        "netEnergyWh": 0,
        "marketRole": "NEUTRAL",
        "availableEnergyWh": 0,
        "requiredEnergyWh": 0,
        "energyType": None,
        "askPriceMicrousdPerKwh": None,
        "maxPriceMicrousdPerKwh": None,
    })

    record = HourlyEnergyRecord.model_validate(
        neutral
    )

    assert record.market_role == MarketRole.NEUTRAL


# --------------------------------------------------
# TEST 4 — Reject invalid record fields
# --------------------------------------------------

@pytest.mark.parametrize(
    "field,value",
    [
        ("productionWh", -1),
        ("productionWh", "6000"),
        ("consumptionWh", -1),
        ("reputation", 101),
        ("energyType", "ANY"),
        ("askPriceMicrousdPerKwh", 0),
        ("evmAddress", "0x1234"),
    ]
)
def test_rejects_invalid_record_field(
    snapshot_data,
    field,
    value
):

    bad = deepcopy(snapshot_data["users"][0])
    bad[field] = value

    with pytest.raises(ValidationError):
        HourlyEnergyRecord.model_validate(bad)


# --------------------------------------------------
# TEST 5 — Reject incorrect SELLER information
# --------------------------------------------------

@pytest.mark.parametrize(
    "field,value",
    [
        ("netEnergyWh", 5000),
        ("marketRole", "BUYER"),
        ("availableEnergyWh", 3000),
        ("requiredEnergyWh", 2),
        ("askPriceMicrousdPerKwh", None),
        ("maxPriceMicrousdPerKwh", 150000),
    ]
)
def test_rejects_invalid_seller_logic(
    snapshot_data,
    field,
    value
):

    bad = deepcopy(snapshot_data["users"][0])
    bad[field] = value

    with pytest.raises(ValidationError):
        HourlyEnergyRecord.model_validate(bad)


# --------------------------------------------------
# TEST 6 — Reject invalid BUYER information
# --------------------------------------------------

def test_rejects_buyer_with_energy_type(
    snapshot_data
):

    bad = deepcopy(snapshot_data["users"][1])

    bad["energyType"] = "SOLAR"

    with pytest.raises(ValidationError):
        HourlyEnergyRecord.model_validate(bad)


# --------------------------------------------------
# TEST 7 — Reject invalid hourly timestamps
# --------------------------------------------------

@pytest.mark.parametrize(
    "time_slot",
    [
        "2026-10-17T14:30:00Z",
        "2026-10-17T14:00:00+00:00",
        "2026-02-30T14:00:00Z",
    ]
)
def test_rejects_invalid_time_slot(
    snapshot_data,
    time_slot
):

    bad = deepcopy(snapshot_data["users"][0])

    bad["timeSlot"] = time_slot

    with pytest.raises(ValidationError):
        HourlyEnergyRecord.model_validate(bad)


# --------------------------------------------------
# TEST 8 — Reject duplicate user IDs
# --------------------------------------------------

def test_rejects_duplicate_snapshot_user(
    snapshot_data
):

    snapshot_data["users"][1]["userId"] = (
        snapshot_data["users"][0]["userId"]
    )

    with pytest.raises(
        ValidationError,
        match="Duplicate userId"
    ):
        EnergySnapshot.model_validate(
            snapshot_data
        )


# --------------------------------------------------
# TEST 9 — Reject duplicate record IDs
# --------------------------------------------------

def test_rejects_duplicate_snapshot_record(
    snapshot_data
):

    snapshot_data["users"][1]["recordId"] = (
        snapshot_data["users"][0]["recordId"]
    )

    with pytest.raises(
        ValidationError,
        match="Duplicate recordId"
    ):
        EnergySnapshot.model_validate(
            snapshot_data
        )


# --------------------------------------------------
# TEST 10 — Reject records from different hours
# --------------------------------------------------

def test_rejects_snapshot_hour_mismatch(
    snapshot_data
):

    snapshot_data["users"][1]["timeSlot"] = (
        "2026-10-17T15:00:00Z"
    )

    with pytest.raises(
        ValidationError,
        match="snapshot timeSlot"
    ):
        EnergySnapshot.model_validate(
            snapshot_data
        )


# --------------------------------------------------
# TEST 11 — Reject an empty snapshot
# --------------------------------------------------

def test_rejects_empty_snapshot(snapshot_data):

    snapshot_data["users"] = []

    with pytest.raises(ValidationError):
        EnergySnapshot.model_validate(
            snapshot_data
        )


# --------------------------------------------------
# TEST 12 — Reject unknown fields
# --------------------------------------------------

def test_rejects_unknown_snapshot_fields(
    snapshot_data
):

    snapshot_data["unexpectedField"] = True

    with pytest.raises(ValidationError):
        EnergySnapshot.model_validate(
            snapshot_data
        )
