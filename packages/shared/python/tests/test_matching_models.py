
import json
from copy import deepcopy
from pathlib import Path

import pytest
from pydantic import ValidationError

from p2p_energy_shared import (
    EnergySnapshot,
    MatchingConfig,
    MatchingInput,
    MatchingOutput,
)


FIXTURES = (
    Path(__file__).resolve().parents[2]
    / "fixtures"
)


def load_fixture(name):
    return json.loads(
        (FIXTURES / name).read_text(
            encoding="utf-8"
        )
    )


# --------------------------------------------------
# TEST 1 — Load MatchingConfig
# --------------------------------------------------

def test_config_loads():

    config = MatchingConfig.model_validate(
        load_fixture("matching-config.sample.json")
    )

    assert config.maximum_distance_km == 10
    assert config.scoring_weights.quantity == 0.30


# --------------------------------------------------
# TEST 2 — Load MatchingInput
# --------------------------------------------------

def test_input_loads():

    matching_input = MatchingInput.model_validate(
        load_fixture("matching-input.sample.json")
    )

    assert len(matching_input.users) == 2


# --------------------------------------------------
# TEST 3 — Load MatchingOutput
# --------------------------------------------------

def test_output_loads():

    output = MatchingOutput.model_validate(
        load_fixture("matching-output.sample.json")
    )

    assert len(output.matches) == 1

    assert (
        output.matches[0].total_amount_microusd
        == 560000
    )


# --------------------------------------------------
# TEST 4 — Build input from snapshot + config
# --------------------------------------------------

def test_build_matching_input_from_snapshot():

    snapshot = EnergySnapshot.model_validate(
        load_fixture("energy-snapshot.sample.json")
    )

    config = MatchingConfig.model_validate(
        load_fixture("matching-config.sample.json")
    )

    matching_input = MatchingInput.from_snapshot(
        snapshot,
        config
    )

    actual = matching_input.model_dump(
        mode="json",
        by_alias=True
    )

    expected = load_fixture(
        "matching-input.sample.json"
    )

    assert actual == expected


# --------------------------------------------------
# TEST 5 — Convert models back to JSON
# --------------------------------------------------

@pytest.mark.parametrize(
    "model,fixture",
    [
        (MatchingConfig, "matching-config.sample.json"),
        (MatchingInput, "matching-input.sample.json"),
        (MatchingOutput, "matching-output.sample.json"),
    ]
)
def test_json_roundtrip(model, fixture):

    raw = load_fixture(fixture)

    parsed = model.model_validate(raw)

    assert parsed.model_dump(
        mode="json",
        by_alias=True
    ) == raw


# --------------------------------------------------
# TEST 6 — Reject invalid scoring weights
# --------------------------------------------------

@pytest.mark.parametrize(
    "field,value",
    [
        ("quantity", -0.1),
        ("price", 1.1),
        ("reputation", 0.1),
    ]
)
def test_rejects_invalid_weights(field, value):

    raw = load_fixture(
        "matching-config.sample.json"
    )

    raw["scoringWeights"][field] = value

    with pytest.raises(ValidationError):
        MatchingConfig.model_validate(raw)


def test_rejects_unknown_scoring_weight():

    raw = load_fixture(
        "matching-config.sample.json"
    )

    raw["scoringWeights"]["unknown"] = 0.1

    with pytest.raises(ValidationError):
        MatchingConfig.model_validate(raw)


# --------------------------------------------------
# TEST 7 — Reject invalid matching distance
# --------------------------------------------------

@pytest.mark.parametrize(
    "distance",
    [0, -10]
)
def test_rejects_invalid_distance_limit(distance):

    raw = load_fixture(
        "matching-config.sample.json"
    )

    raw["maximumDistanceKm"] = distance

    with pytest.raises(ValidationError):
        MatchingConfig.model_validate(raw)


# --------------------------------------------------
# TEST 8 — Reject inconsistent input hour
# --------------------------------------------------

def test_rejects_inconsistent_input_hour():

    raw = load_fixture(
        "matching-input.sample.json"
    )

    raw["users"][0]["timeSlot"] = (
        "2026-10-17T15:00:00Z"
    )

    with pytest.raises(
        ValidationError,
        match="timeSlot"
    ):
        MatchingInput.model_validate(raw)


# --------------------------------------------------
# TEST 9 — Reject duplicate user
# --------------------------------------------------

def test_rejects_duplicate_user():

    raw = load_fixture(
        "matching-input.sample.json"
    )

    raw["users"][1]["userId"] = (
        raw["users"][0]["userId"]
    )

    with pytest.raises(
        ValidationError,
        match="Duplicate userId"
    ):
        MatchingInput.model_validate(raw)


# --------------------------------------------------
# TEST 10 — Reject duplicate record
# --------------------------------------------------

def test_rejects_duplicate_record():

    raw = load_fixture(
        "matching-input.sample.json"
    )

    raw["users"][1]["recordId"] = (
        raw["users"][0]["recordId"]
    )

    with pytest.raises(
        ValidationError,
        match="Duplicate recordId"
    ):
        MatchingInput.model_validate(raw)


# --------------------------------------------------
# TEST 11 — Reject incompatible schema versions
# --------------------------------------------------

def test_rejects_mismatching_versions_in_builder():

    snapshot = EnergySnapshot.model_validate(
        load_fixture("energy-snapshot.sample.json")
    )

    raw = load_fixture(
        "matching-config.sample.json"
    )

    raw["schemaVersion"] = "2.0.0"

    config = MatchingConfig.model_validate(raw)

    with pytest.raises(
        ValueError,
        match="schema versions differ"
    ):
        MatchingInput.from_snapshot(
            snapshot,
            config
        )


# --------------------------------------------------
# TEST 12 — Reject incorrect payment
# --------------------------------------------------

def test_rejects_wrong_payment():

    raw = load_fixture(
        "matching-output.sample.json"
    )

    raw["matches"][0]["totalAmountMicrousd"] = 999

    with pytest.raises(
        ValidationError,
        match="totalAmountMicrousd"
    ):
        MatchingOutput.model_validate(raw)


# --------------------------------------------------
# TEST 13 — Reject duplicate buyer matches
# --------------------------------------------------

def test_rejects_duplicate_buyer_matches():

    raw = load_fixture(
        "matching-output.sample.json"
    )

    duplicate = deepcopy(raw["matches"][0])

    duplicate["matchId"] = (
        "77777777-7777-4777-8777-777777777777"
    )

    raw["matches"].append(duplicate)

    with pytest.raises(
        ValidationError,
        match="Buyer matched more than once"
    ):
        MatchingOutput.model_validate(raw)


# --------------------------------------------------
# TEST 14 — Reject duplicate match IDs
# --------------------------------------------------

def test_rejects_duplicate_match_ids():

    raw = load_fixture(
        "matching-output.sample.json"
    )

    raw["matches"].append(
        deepcopy(raw["matches"][0])
    )

    with pytest.raises(
        ValidationError,
        match="Duplicate matchId"
    ):
        MatchingOutput.model_validate(raw)


# --------------------------------------------------
# TEST 15 — Reject inconsistent match hour
# --------------------------------------------------

def test_rejects_mismatching_result_time():

    raw = load_fixture(
        "matching-output.sample.json"
    )

    raw["matches"][0]["timeSlot"] = (
        "2026-10-17T15:00:00Z"
    )

    with pytest.raises(
        ValidationError,
        match="timeSlot"
    ):
        MatchingOutput.model_validate(raw)


# --------------------------------------------------
# TEST 16 — Reject duplicate unmatched buyers
# --------------------------------------------------

def test_rejects_duplicate_unmatched_buyers():

    raw = load_fixture(
        "matching-output.sample.json"
    )

    buyer_id = raw["matches"][0]["buyerId"]

    raw["matches"] = []

    raw["unmatchedBuyerIds"] = [
        buyer_id,
        buyer_id,
    ]

    with pytest.raises(
        ValidationError,
        match="Duplicate unmatchedBuyerIds"
    ):
        MatchingOutput.model_validate(raw)


# --------------------------------------------------
# TEST 17 — Reject matched and unmatched overlap
# --------------------------------------------------

def test_rejects_matched_buyer_as_unmatched():

    raw = load_fixture(
        "matching-output.sample.json"
    )

    raw["unmatchedBuyerIds"] = [
        raw["matches"][0]["buyerId"]
    ]

    with pytest.raises(
        ValidationError,
        match="both matched and unmatched"
    ):
        MatchingOutput.model_validate(raw)


# --------------------------------------------------
# TEST 18 — Reject invalid creation timestamps
# --------------------------------------------------

@pytest.mark.parametrize(
    "timestamp",
    [
        "2026-02-30T14:00:01Z",
        "2026-10-17T14:00:01+00:00",
    ]
)
def test_rejects_invalid_created_at(timestamp):

    raw = load_fixture(
        "matching-output.sample.json"
    )

    raw["matches"][0]["createdAt"] = timestamp

    with pytest.raises(ValidationError):
        MatchingOutput.model_validate(raw)


# --------------------------------------------------
# TEST 19 — Reject score outside 0..1
# --------------------------------------------------

def test_rejects_score_outside_range():

    raw = load_fixture(
        "matching-output.sample.json"
    )

    raw["matches"][0]["score"] = 1.2

    with pytest.raises(ValidationError):
        MatchingOutput.model_validate(raw)


# --------------------------------------------------
# TEST 20 — Accept a valid no-match result
# --------------------------------------------------

def test_accepts_no_match_output():

    raw = load_fixture(
        "matching-output.sample.json"
    )

    buyer_id = raw["matches"][0]["buyerId"]

    raw["matches"] = []
    raw["unmatchedBuyerIds"] = [buyer_id]

    parsed = MatchingOutput.model_validate(raw)

    assert parsed.matches == []
    assert len(parsed.unmatched_buyer_ids) == 1


# --------------------------------------------------
# TEST 21 — Reject unexpected fields
# --------------------------------------------------

def test_rejects_unexpected_output_field():

    raw = load_fixture(
        "matching-output.sample.json"
    )

    raw["unexpectedField"] = True

    with pytest.raises(ValidationError):
        MatchingOutput.model_validate(raw)
