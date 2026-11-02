
"""CLI and JSON I/O tests for off-chain delivery simulation."""

import json
import subprocess
import sys

from pathlib import Path

import pytest

from jsonschema import (
    Draft202012Validator,
    FormatChecker,
)

from referencing import Registry, Resource

from p2p_energy_shared import (
    DeliveryRecord,
    DeliveryStatus,
)

from data_generator.cli import main

from data_generator.delivery_io import (
    load_active_trade,
    load_delivery_config,
    save_delivery_record,
)

from data_generator.delivery_simulator import (
    DeliveryScenario,
)


ROOT = Path(__file__).resolve().parents[3]

SERVICE = Path(__file__).resolve().parents[1]

TRADE_SAMPLE = (
    SERVICE / "fixtures" / "active-trade.sample.json"
)

CONFIG_SAMPLE = (
    SERVICE / "config" / "delivery-simulation-config.json"
)

SCHEMAS = (
    ROOT / "packages" / "shared" / "schemas"
)


def read_json(path):
    return json.loads(
        Path(path).read_text(encoding="utf-8")
    )


def write_json(path, data):
    Path(path).write_text(
        json.dumps(data, indent=2),
        encoding="utf-8",
    )


@pytest.fixture
def case(tmp_path):

    trade_path = tmp_path / "active-trade.json"
    config_path = tmp_path / "delivery-config.json"

    trade_path.write_bytes(
        TRADE_SAMPLE.read_bytes()
    )

    config_path.write_bytes(
        CONFIG_SAMPLE.read_bytes()
    )

    return {
        "input": trade_path,
        "config": config_path,
        "output": tmp_path / "delivery.json",
    }


def args(case, *extra):

    return [
        "generate-delivery",
        "--input", str(case["input"]),
        "--config", str(case["config"]),
        "--output", str(case["output"]),
        *extra,
    ]


def change_config(case, **updates):

    raw = read_json(case["config"])
    raw.update(updates)

    write_json(case["config"], raw)


def output(case):

    return DeliveryRecord.model_validate_json(
        case["output"].read_text(encoding="utf-8")
    )


# --------------------------------------------------
# Test 1: Load existing examples
# --------------------------------------------------

def test_loads_sample_trade_and_config():

    trade = load_active_trade(TRADE_SAMPLE)
    config = load_delivery_config(CONFIG_SAMPLE)

    assert trade.expected_wh == 4000
    assert config.scenario is DeliveryScenario.SUCCESS
    assert config.delivered_wh == 4000


# --------------------------------------------------
# Test 2: Run a successful delivery
# --------------------------------------------------

def test_cli_success(case, capsys):

    assert main(args(case)) == 0

    record = output(case)

    assert record.status is DeliveryStatus.SUCCESS
    assert record.delivered_wh == 4000
    assert record.time_slot == "2026-10-18T14:30:00Z"
    assert record.evidence_hash is None

    assert (
        "PASS: delivery simulated"
        in capsys.readouterr().out
    )


# --------------------------------------------------
# Test 3: Validate exported JSON Schema
# --------------------------------------------------

def test_output_validates_json_schema(case):

    assert main(args(case)) == 0

    raw = read_json(case["output"])

    assert "evidenceHash" not in raw

    registry = Registry()

    for path in sorted(
        SCHEMAS.glob("*.schema.json")
    ):
        schema = read_json(path)

        registry = registry.with_resource(
            schema["$id"],
            Resource.from_contents(schema),
        )

    validator = Draft202012Validator(
        read_json(
            SCHEMAS / "delivery-record.schema.json"
        ),
        registry=registry,
        format_checker=FormatChecker(),
    )

    validator.validate(raw)


# --------------------------------------------------
# Test 4: All record-producing scenarios
# --------------------------------------------------

@pytest.mark.parametrize(
    "scenario,expected",
    [
        ("SUCCESS", "SUCCESS"),
        ("INCOMPLETE", "INCOMPLETE"),
        ("INVALID", "INVALID"),
    ],
)
def test_cli_record_scenarios(
    case,
    scenario,
    expected,
):

    change_config(
        case,
        scenario=scenario,
        deliveredWh=None,
        reportedAt=None,
    )

    assert main(args(case)) == 0

    assert output(case).status.value == expected


# --------------------------------------------------
# Test 5: Missing delivery produces no file
# --------------------------------------------------

def test_cli_missing_produces_no_file(
    case,
    capsys,
):

    change_config(
        case,
        scenario="MISSING",
        deliveredWh=None,
        reportedAt=None,
    )

    assert main(args(case)) == 0
    assert not case["output"].exists()

    assert (
        "no record was written"
        in capsys.readouterr().out
    )


# --------------------------------------------------
# Test 6: Missing delivery protects stale output
# --------------------------------------------------

def test_missing_rejects_stale_file(case):

    change_config(
        case,
        scenario="MISSING",
        deliveredWh=None,
        reportedAt=None,
    )

    case["output"].write_text(
        "old result",
        encoding="utf-8",
    )

    assert main(args(case, "--overwrite")) == 3

    assert (
        case["output"].read_text(encoding="utf-8")
        == "old result"
    )


# --------------------------------------------------
# Test 7: Deterministic delivery IDs
# --------------------------------------------------

def test_cli_reproducible_delivery_ids(case):

    assert main(args(case)) == 0

    initial = output(case).delivery_id

    assert main(args(case, "--overwrite")) == 0

    assert output(case).delivery_id == initial


# --------------------------------------------------
# Test 8: Prevent accidental overwriting
# --------------------------------------------------

def test_cli_prevents_overwrite(case):

    assert main(args(case)) == 0

    previous_bytes = case["output"].read_bytes()

    assert main(args(case)) == 3

    assert (
        case["output"].read_bytes()
        == previous_bytes
    )


# --------------------------------------------------
# Test 9: Explicit overwriting
# --------------------------------------------------

def test_cli_explicit_overwrite(case):

    case["output"].write_text(
        "stale",
        encoding="utf-8",
    )

    assert main(args(case, "--overwrite")) == 0

    assert output(case).status is DeliveryStatus.SUCCESS


# --------------------------------------------------
# Test 10: Nested output directories
# --------------------------------------------------

def test_cli_creates_output_directory(case):

    case["output"] = (
        case["output"].parent
        / "nested"
        / "delivery.json"
    )

    assert main(args(case)) == 0
    assert case["output"].is_file()


# --------------------------------------------------
# Test 11: Malformed JSON
# --------------------------------------------------

@pytest.mark.parametrize(
    "target",
    ["input", "config"],
)
def test_cli_rejects_invalid_json(case, target):

    case[target].write_text(
        "{oops",
        encoding="utf-8",
    )

    assert main(args(case)) == 2
    assert not case["output"].exists()


# --------------------------------------------------
# Test 12: Missing files
# --------------------------------------------------

@pytest.mark.parametrize(
    "target",
    ["input", "config"],
)
def test_cli_rejects_missing_source(case, target):

    case[target].unlink()

    assert main(args(case)) == 2
    assert not case["output"].exists()


# --------------------------------------------------
# Test 13: Non-object JSON
# --------------------------------------------------

@pytest.mark.parametrize(
    "target",
    ["input", "config"],
)
def test_cli_rejects_non_object_source(
    case,
    target,
):

    case[target].write_text(
        "[]",
        encoding="utf-8",
    )

    assert main(args(case)) == 2


# --------------------------------------------------
# Test 14: Reject inactive trades
# --------------------------------------------------

def test_cli_rejects_wrong_trade_status(case):

    raw = read_json(case["input"])
    raw["status"] = "CREATED"

    write_json(case["input"], raw)

    assert main(args(case)) == 2


# --------------------------------------------------
# Test 15: Reject unknown delivery scenarios
# --------------------------------------------------

def test_cli_rejects_unrecognized_config(case):

    change_config(
        case,
        scenario="UNKNOWN",
    )

    assert main(args(case)) == 2


# --------------------------------------------------
# Test 16: Reject insufficient successful delivery
# --------------------------------------------------

def test_cli_rejects_short_success(case):

    change_config(
        case,
        deliveredWh=3000,
    )

    assert main(args(case)) == 2


# --------------------------------------------------
# Test 17: Missing cannot contain measurements
# --------------------------------------------------

def test_cli_rejects_missing_with_measurements(
    case,
):

    change_config(
        case,
        scenario="MISSING",
    )

    assert main(args(case)) == 2


# --------------------------------------------------
# Test 18: Invalid timestamp
# --------------------------------------------------

def test_cli_rejects_invalid_reported_time(case):

    change_config(
        case,
        reportedAt="not-utc",
    )

    assert main(args(case)) == 2


# --------------------------------------------------
# Test 19: Never overwrite source files
# --------------------------------------------------

@pytest.mark.parametrize(
    "target",
    ["input", "config"],
)
def test_cli_never_overwrites_source(
    case,
    target,
):

    original = case[target].read_bytes()
    case["output"] = case[target]

    assert main(args(case, "--overwrite")) == 2

    assert case[target].read_bytes() == original


# --------------------------------------------------
# Test 20: Output write errors
# --------------------------------------------------

def test_cli_write_failure_returns_three(case):

    blocker = case["output"].parent / "blocker"

    blocker.write_text(
        "file",
        encoding="utf-8",
    )

    case["output"] = blocker / "delivery.json"

    assert main(args(case)) == 3


# --------------------------------------------------
# Test 21: Real subprocess execution
# --------------------------------------------------

def test_cli_runs_as_separate_process(case):

    process = subprocess.run(
        [
            sys.executable,
            "-m",
            "data_generator.cli",
            *args(case),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )

    assert process.returncode == 0, process.stderr
    assert case["output"].is_file()


# --------------------------------------------------
# Test 22: CLI help and argument validation
# --------------------------------------------------

def test_cli_help_and_required_arguments(capsys):

    with pytest.raises(SystemExit) as error:
        main([
            "generate-delivery",
            "--help",
        ])

    assert error.value.code == 0

    assert "--config" in capsys.readouterr().out

    with pytest.raises(SystemExit) as error:
        main(["generate-delivery"])

    assert error.value.code == 2


# --------------------------------------------------
# Test 23: Input files remain unchanged
# --------------------------------------------------

def test_inputs_unchanged(case):

    original_input = case["input"].read_bytes()
    original_config = case["config"].read_bytes()

    assert main(args(case)) == 0

    assert (
        case["input"].read_bytes()
        == original_input
    )

    assert (
        case["config"].read_bytes()
        == original_config
    )


# --------------------------------------------------
# Test 24: Save function rejects incorrect objects
# --------------------------------------------------

def test_save_rejects_wrong_record_type(tmp_path):

    with pytest.raises(TypeError):
        save_delivery_record(
            {},
            tmp_path / "invalid.json",
        )


# --------------------------------------------------
# Test 25: Strict configuration quantities
# --------------------------------------------------

def test_config_rejects_fractional_quantity(case):

    change_config(
        case,
        deliveredWh=3.14,
    )

    assert main(args(case)) == 2
