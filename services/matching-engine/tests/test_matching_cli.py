
"""
Tests for the Matching Engine CLI and JSON integration.

Verifies:
- MatchingInput and EnergySnapshot support
- Validated JSON output
- Zero-match markets
- Reproducible match IDs
- File protection
- CLI process execution
- Exit codes and input validation
"""

import json
import subprocess
import sys

from pathlib import Path

import pytest

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

from p2p_energy_shared import MatchingOutput

from matching_engine.cli import main


ROOT = Path(__file__).resolve().parents[3]

FIXTURES = (
    ROOT / "packages" / "shared" / "fixtures"
)

SCHEMAS = (
    ROOT / "packages" / "shared" / "schemas"
)

SAMPLE_INPUT = (
    FIXTURES / "matching-input.sample.json"
)

SAMPLE_SNAPSHOT = (
    FIXTURES / "energy-snapshot.sample.json"
)

SAMPLE_CONFIG = (
    FIXTURES / "matching-config.sample.json"
)


def read_json(path):
    return json.loads(
        path.read_text(encoding="utf-8")
    )


@pytest.fixture
def case(tmp_path):

    input_path = tmp_path / "input.json"
    config_path = tmp_path / "config.json"
    output_path = tmp_path / "matching-output.json"

    input_path.write_bytes(
        SAMPLE_INPUT.read_bytes()
    )

    config_path.write_bytes(
        SAMPLE_CONFIG.read_bytes()
    )

    return {
        "input": input_path,
        "config": config_path,
        "output": output_path,
    }


def arguments(case, *extra):

    return [
        "--input", str(case["input"]),
        "--output", str(case["output"]),
        "--config", str(case["config"]),
        *extra,
    ]


def load_output(case):

    return MatchingOutput.model_validate_json(
        case["output"].read_text(
            encoding="utf-8"
        )
    )


# --------------------------------------------------
# TEST 1 — Execute matching from MatchingInput JSON
# --------------------------------------------------

def test_cli_generates_valid_matching_output(case):

    assert main(arguments(case)) == 0

    output = load_output(case)

    assert len(output.matches) == 1
    assert output.unmatched_buyer_ids == []

    match = output.matches[0]

    assert match.quantity_wh == 4000
    assert match.total_amount_microusd == 560000

    assert match.created_at.endswith("Z")
    assert output.execution_time_ms >= 0


# --------------------------------------------------
# TEST 2 — Output follows shared JSON Schema
# --------------------------------------------------

def test_cli_output_matches_json_schema(case):

    assert main(arguments(case)) == 0

    raw_output = read_json(case["output"])

    registry = Registry()

    for path in sorted(
        SCHEMAS.glob("*.schema.json")
    ):
        schema = read_json(path)

        registry = registry.with_resource(
            schema["$id"],
            Resource.from_contents(schema),
        )

    output_schema = read_json(
        SCHEMAS / "matching-output.schema.json"
    )

    validator = Draft202012Validator(
        output_schema,
        registry=registry,
        format_checker=FormatChecker(),
    )

    validator.validate(raw_output)


# --------------------------------------------------
# TEST 3 — Accept Data Generator EnergySnapshots
# --------------------------------------------------

def test_cli_accepts_energy_snapshot(case):

    case["input"].write_bytes(
        SAMPLE_SNAPSHOT.read_bytes()
    )

    assert main(arguments(case)) == 0

    snapshot = read_json(case["input"])
    output = load_output(case)

    assert str(output.snapshot_id) == (
        snapshot["snapshotId"]
    )

    assert output.time_slot == snapshot["timeSlot"]

    assert isinstance(output.matches, list)


# --------------------------------------------------
# TEST 4 — Market without sellers is valid
# --------------------------------------------------

def test_cli_no_sellers(case):

    raw = read_json(case["input"])

    raw["users"] = [
        user
        for user in raw["users"]
        if user["marketRole"] == "BUYER"
    ]

    case["input"].write_text(
        json.dumps(raw),
        encoding="utf-8",
    )

    assert main(arguments(case)) == 0

    output = load_output(case)

    assert output.matches == []
    assert len(output.unmatched_buyer_ids) == 1


# --------------------------------------------------
# TEST 5 — Market without buyers is valid
# --------------------------------------------------

def test_cli_no_buyers(case):

    raw = read_json(case["input"])

    raw["users"] = [
        user
        for user in raw["users"]
        if user["marketRole"] == "SELLER"
    ]

    case["input"].write_text(
        json.dumps(raw),
        encoding="utf-8",
    )

    assert main(arguments(case)) == 0

    output = load_output(case)

    assert output.matches == []
    assert output.unmatched_buyer_ids == []


# --------------------------------------------------
# TEST 6 — Identical input produces identical IDs
# --------------------------------------------------

def test_cli_match_ids_are_reproducible(case):

    assert main(arguments(case)) == 0

    first_ids = [
        item.match_id
        for item in load_output(case).matches
    ]

    assert main(
        arguments(case, "--overwrite")
    ) == 0

    second_ids = [
        item.match_id
        for item in load_output(case).matches
    ]

    assert first_ids == second_ids


# --------------------------------------------------
# TEST 7 — Protect existing output files
# --------------------------------------------------

def test_cli_prevents_overwriting(case):

    assert main(arguments(case)) == 0

    original = case["output"].read_bytes()

    assert main(arguments(case)) == 3

    assert case["output"].read_bytes() == original


# --------------------------------------------------
# TEST 8 — Allow explicit output replacement
# --------------------------------------------------

def test_cli_allows_overwrite(case):

    assert main(arguments(case)) == 0

    case["output"].write_text(
        "old data",
        encoding="utf-8",
    )

    assert main(
        arguments(case, "--overwrite")
    ) == 0

    assert len(load_output(case).matches) == 1


# --------------------------------------------------
# TEST 9 — Create nested output directories
# --------------------------------------------------

def test_cli_creates_output_directories(case):

    case["output"] = (
        case["output"].parent
        / "nested"
        / "results"
        / "matching.json"
    )

    assert main(arguments(case)) == 0
    assert case["output"].is_file()


# --------------------------------------------------
# TEST 10 — Keep stdout empty
# --------------------------------------------------

def test_cli_writes_diagnostics_to_stderr(
    case, capsys
):

    assert main(arguments(case)) == 0

    captured = capsys.readouterr()

    assert captured.out == ""
    assert "PASS: Matching completed" in captured.err
    assert "Matches: 1" in captured.err


# --------------------------------------------------
# TEST 11 — Run through a real Python subprocess
# --------------------------------------------------

def test_cli_runs_as_separate_process(case):

    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "matching_engine.cli",
            *arguments(case),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout == ""
    assert case["output"].is_file()


# --------------------------------------------------
# TEST 12 — Reject malformed input/configuration
# --------------------------------------------------

@pytest.mark.parametrize(
    "target",
    ["input", "config"],
)
def test_cli_rejects_invalid_json(case, target):

    case[target].write_text(
        "{ invalid JSON",
        encoding="utf-8",
    )

    assert main(arguments(case)) == 2
    assert not case["output"].exists()


# --------------------------------------------------
# TEST 13 — Reject missing input/configuration files
# --------------------------------------------------

@pytest.mark.parametrize(
    "target",
    ["input", "config"],
)
def test_cli_rejects_missing_files(case, target):

    case[target].unlink()

    assert main(arguments(case)) == 2
    assert not case["output"].exists()


# --------------------------------------------------
# TEST 14 — Reject incompatible matching settings
# --------------------------------------------------

def test_cli_rejects_config_mismatch(case):

    raw = read_json(case["input"])

    raw["algorithmVersion"] = "9.9.9"

    case["input"].write_text(
        json.dumps(raw),
        encoding="utf-8",
    )

    assert main(arguments(case)) == 2
    assert not case["output"].exists()


# --------------------------------------------------
# TEST 15 — Reject incomplete MatchingInput records
# --------------------------------------------------

def test_cli_rejects_invalid_matching_input(case):

    raw = read_json(case["input"])

    raw["users"][0].pop("evmAddress")

    case["input"].write_text(
        json.dumps(raw),
        encoding="utf-8",
    )

    assert main(arguments(case)) == 2
    assert not case["output"].exists()


# --------------------------------------------------
# TEST 16 — Reject invalid EnergySnapshot content
# --------------------------------------------------

def test_cli_rejects_invalid_snapshot(case):

    raw = read_json(SAMPLE_SNAPSHOT)

    raw["timeSlot"] = "invalid-time-slot"

    case["input"].write_text(
        json.dumps(raw),
        encoding="utf-8",
    )

    assert main(arguments(case)) == 2
    assert not case["output"].exists()


# --------------------------------------------------
# TEST 17 — Distinguish file-writing failures
# --------------------------------------------------

def test_cli_reports_output_write_failure(case):

    blocker = case["output"].parent / "blocker"

    blocker.write_text(
        "I am a file",
        encoding="utf-8",
    )

    case["output"] = blocker / "result.json"

    assert main(arguments(case)) == 3


# --------------------------------------------------
# TEST 18 — Never overwrite input or configuration
# --------------------------------------------------

@pytest.mark.parametrize(
    "target",
    ["input", "config"],
)
def test_cli_never_overwrites_source_files(
    case, target
):

    original = case[target].read_bytes()

    case["output"] = case[target]

    assert main(
        arguments(case, "--overwrite")
    ) == 2

    assert case[target].read_bytes() == original


# --------------------------------------------------
# TEST 19 — Require all CLI arguments
# --------------------------------------------------

def test_cli_requires_arguments():

    with pytest.raises(SystemExit) as error:
        main([])

    assert error.value.code == 2


# --------------------------------------------------
# TEST 20 — Require JSON objects
# --------------------------------------------------

def test_cli_rejects_non_object_json(case):

    case["input"].write_text(
        "[]",
        encoding="utf-8",
    )

    assert main(arguments(case)) == 2
    assert not case["output"].exists()
