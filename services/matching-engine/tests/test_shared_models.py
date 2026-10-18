
import json
from pathlib import Path

from p2p_energy_shared import (
    EnergySnapshot,
    MatchingConfig,
    MatchingInput,
    MatchingOutput,
)


ROOT = Path(__file__).resolve().parents[3]

FIXTURES = ROOT / "packages" / "shared" / "fixtures"


def read_json(filename):
    return json.loads(
        (FIXTURES / filename).read_text(
            encoding="utf-8"
        )
    )


# --------------------------------------------------
# TEST 1 — Build matching input from shared models
# --------------------------------------------------

def test_matcher_can_build_input():

    snapshot = EnergySnapshot.model_validate(
        read_json("energy-snapshot.sample.json")
    )

    config = MatchingConfig.model_validate(
        read_json("matching-config.sample.json")
    )

    matching_input = MatchingInput.from_snapshot(
        snapshot,
        config,
    )

    expected = read_json(
        "matching-input.sample.json"
    )

    assert matching_input.model_dump(
        mode="json",
        by_alias=True
    ) == expected


# --------------------------------------------------
# TEST 2 — Read matching output using shared models
# --------------------------------------------------

def test_matcher_can_load_output():

    data = read_json(
        "matching-output.sample.json"
    )

    output = MatchingOutput.model_validate(data)

    assert len(output.matches) == 1
    assert output.matches[0].quantity_wh == 4000
    assert output.matches[0].total_amount_microusd == 560000
