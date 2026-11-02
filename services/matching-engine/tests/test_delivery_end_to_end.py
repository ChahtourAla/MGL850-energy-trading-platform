
"""
Three-service integration test:

Data Generator -> Matching Engine -> Delivery Simulator.

All wallets and trade identifiers are fictional test data.
No backend, database, or Hedera calls are performed.
"""

import json
import subprocess
import sys

from datetime import datetime, timedelta
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5

import pytest

from jsonschema import (
    Draft202012Validator,
    FormatChecker,
)

from referencing import Registry, Resource

from p2p_energy_shared import (
    DeliveryRecord,
    DeliveryStatus,
    EnergySnapshot,
    MatchingOutput,
)

from data_generator.delivery_simulator import (
    ActiveTrade,
)


# --------------------------------------------------
# 1. Repository paths
# --------------------------------------------------

ROOT = Path(__file__).resolve().parents[3]

GENERATOR_DIR = (
    ROOT / "services" / "data-generator"
)

SHARED_DIR = ROOT / "packages" / "shared"

SCHEMAS_DIR = SHARED_DIR / "schemas"

MATCHING_CONFIG = (
    SHARED_DIR
    / "fixtures"
    / "matching-config.sample.json"
)

TIME_SLOT = "2026-10-18T12:00:00Z"


# --------------------------------------------------
# 2. General helpers
# --------------------------------------------------

def read_json(path):

    return json.loads(
        Path(path).read_text(encoding="utf-8")
    )


def write_json(path, document):

    Path(path).write_text(
        json.dumps(document, indent=2) + "\n",
        encoding="utf-8",
    )


def run_cli(
    module,
    *args,
    expected_code=0,
):
    """
    Execute a Python service in a separate process.
    """

    process = subprocess.run(
        [
            sys.executable,
            "-m",
            module,
            *map(str, args),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )

    assert process.returncode == expected_code, (
        f"{module} returned {process.returncode}; "
        f"expected {expected_code}\n"
        f"STDOUT:\n{process.stdout}\n"
        f"STDERR:\n{process.stderr}"
    )

    return process


# --------------------------------------------------
# 3. Validate DeliveryRecord JSON
# --------------------------------------------------

def schema_validate_delivery(path):

    registry = Registry()

    for schema_path in sorted(
        SCHEMAS_DIR.glob("*.schema.json")
    ):

        schema = read_json(schema_path)

        registry = registry.with_resource(
            schema["$id"],
            Resource.from_contents(schema),
        )

    validator = Draft202012Validator(
        read_json(
            SCHEMAS_DIR / "delivery-record.schema.json"
        ),
        registry=registry,
        format_checker=FormatChecker(),
    )

    validator.validate(read_json(path))


# --------------------------------------------------
# 4. Convert a match into a FICTIONAL active trade
# --------------------------------------------------

def fictional_active_trade(
    match,
    *,
    number=1,
):
    """
    Test-only adapter.

    Real tradeId and onChainTradeId values must be
    provided by the backend and Hedera integration.

    This function must not be used to claim that
    an actual blockchain transaction was created.
    """

    start = datetime.fromisoformat(
        match.time_slot.replace("Z", "+00:00")
    ) + timedelta(hours=1)

    end = start + timedelta(hours=1)

    document = {
        "tradeId": str(
            uuid5(
                NAMESPACE_URL,
                f"test-trade:{match.match_id}",
            )
        ),

        "onChainTradeId": 900000 + number,

        "sellerId": str(match.seller_id),
        "buyerId": str(match.buyer_id),

        "expectedWh": match.quantity_wh,

        "deliveryStart": (
            start.isoformat().replace("+00:00", "Z")
        ),

        "deliveryDeadline": (
            end.isoformat().replace("+00:00", "Z")
        ),

        "status": "AWAITING_DELIVERY",
    }

    # Validate using the real D1 model.
    ActiveTrade.model_validate(document)

    return document


# --------------------------------------------------
# 5. Execute delivery simulation via the real CLI
# --------------------------------------------------

def generate_delivery(
    tmp_path,
    active_trade,
    scenario,
    *,
    delivered_wh=None,
    reported_at=None,
    expected_code=0,
    name="delivery",
):

    trade_path = (
        tmp_path / f"{name}-active-trade.json"
    )

    config_path = (
        tmp_path / f"{name}-delivery-config.json"
    )

    result_path = (
        tmp_path / f"{name}-delivery-record.json"
    )

    write_json(
        trade_path,
        active_trade,
    )

    write_json(
        config_path,
        {
            "scenario": scenario,
            "deliveredWh": delivered_wh,
            "reportedAt": reported_at,
        },
    )

    process = run_cli(
        "data_generator.cli",
        "generate-delivery",

        "--input",
        trade_path,

        "--config",
        config_path,

        "--output",
        result_path,

        expected_code=expected_code,
    )

    # Failed input validation and MISSING do not
    # produce any DeliveryRecord JSON file.
    if (
        expected_code != 0
        or scenario == "MISSING"
    ):

        assert not result_path.exists()

        return process, None

    # Validate both JSON Schema and Pydantic.
    schema_validate_delivery(result_path)

    record = DeliveryRecord.model_validate_json(
        result_path.read_text(encoding="utf-8")
    )

    return process, record


# --------------------------------------------------
# 6. Generate a complete market through real CLIs
# --------------------------------------------------

@pytest.fixture(scope="module")
def pipeline(tmp_path_factory):
    """
    Build:
    12 users -> energy snapshot -> 2 matches.
    """

    work = tmp_path_factory.mktemp(
        "energy_matching_delivery"
    )

    static_path = (
        work / "static-users.json"
    )

    enriched_path = (
        work / "enriched-users.json"
    )

    energy_config_path = (
        work / "energy-config.json"
    )

    snapshot_dir = (
        work / "snapshots"
    )

    matching_path = (
        work / "matches.json"
    )

    # ----------------------------------------------
    # A. Generate 12 fictional households
    # ----------------------------------------------

    run_cli(
        "data_generator.cli",
        "generate-users",

        "--config",
        (
            GENERATOR_DIR
            / "config"
            / "user-registry-config.json"
        ),

        "--output",
        static_path,
    )

    registry = read_json(static_path)

    assert len(registry["users"]) == 12

    # ----------------------------------------------
    # B. Attach fictional wallet information
    # ----------------------------------------------

    for number, user in enumerate(
        registry["users"],
        start=1,
    ):

        user["hederaAccountId"] = (
            f"0.0.{950000 + number}"
        )

        user["evmAddress"] = (
            f"0x{number:040x}"
        )

        user["xKm"] = (
            2.0 + number * 0.05
        )

        user["yKm"] = (
            2.0 + number * 0.05
        )

        if number > 1:
            user["preferredEnergyType"] = "ANY"

    write_json(
        enriched_path,
        registry,
    )

    run_cli(
        "data_generator.cli",
        "validate-users",

        "--input",
        enriched_path,

        "--require-wallets",
    )

    # ----------------------------------------------
    # C. Prepare deterministic energy configuration
    # ----------------------------------------------

    config = read_json(
        GENERATOR_DIR
        / "config"
        / "energy-generation-config.json"
    )

    config["productionEnergyTypeWeights"] = {
        "SOLAR": 1.0,
        "WIND": 0.0,
        "HYDRO": 0.0,
        "GRID": 0.0,
        "MIXED": 0.0,
    }

    config["productionVariationFraction"] = 0.0
    config["consumptionVariationFraction"] = 0.0

    config["sellerAskPriceRange"] = {
        "minMicrousdPerKwh": 140000,
        "maxMicrousdPerKwh": 140000,
    }

    config["buyerMaxPriceRange"] = {
        "minMicrousdPerKwh": 170000,
        "maxMicrousdPerKwh": 170000,
    }

    write_json(
        energy_config_path,
        config,
    )

    # ----------------------------------------------
    # D. Generate an EnergySnapshot
    # ----------------------------------------------

    arguments = [
        "generate-snapshot",

        "--registry",
        enriched_path,

        "--config",
        energy_config_path,

        "--time-slot",
        TIME_SLOT,

        "--output-dir",
        snapshot_dir,
    ]

    # First household produces solar energy.
    # The other eleven households only consume.
    for user in registry["users"][1:]:

        arguments.extend([
            "--consumption-only-user-id",
            user["userId"],
        ])

    run_cli(
        "data_generator.cli",
        *arguments,
    )

    snapshot_path = (
        snapshot_dir
        / f"energy_snapshot_{TIME_SLOT[:13]}.json"
    )

    assert snapshot_path.is_file()

    # ----------------------------------------------
    # E. Execute the Matching Engine
    # ----------------------------------------------

    run_cli(
        "matching_engine.cli",

        "--input",
        snapshot_path,

        "--config",
        MATCHING_CONFIG,

        "--output",
        matching_path,
    )

    assert matching_path.is_file()

    # ----------------------------------------------
    # F. Validate generated files
    # ----------------------------------------------

    snapshot = EnergySnapshot.model_validate_json(
        snapshot_path.read_text(encoding="utf-8")
    )

    matching = MatchingOutput.model_validate_json(
        matching_path.read_text(encoding="utf-8")
    )

    assert matching.snapshot_id == snapshot.snapshot_id

    assert len(matching.matches) == 2

    return {
        "snapshot": snapshot,
        "matching": matching,
    }


# ==================================================
# TEST 1 — The complete generation and matching path
# ==================================================

def test_three_stage_pipeline_produces_real_matches(
    pipeline,
):

    assert len(pipeline["snapshot"].users) == 12

    assert len(pipeline["matching"].matches) == 2

    assert (
        len(pipeline["matching"].unmatched_buyer_ids)
        == 9
    )

    assert (
        pipeline["matching"].matches[0].quantity_wh
        == 2125
    )


# ==================================================
# TEST 2 — Successful delivery preserves match data
# ==================================================

def test_successful_delivery_preserves_matching_participants(
    pipeline,
    tmp_path,
):

    match = pipeline["matching"].matches[0]

    active = fictional_active_trade(match)

    _, record = generate_delivery(
        tmp_path,
        active,
        "SUCCESS",
    )

    assert record.status == DeliveryStatus.SUCCESS

    assert record.expected_wh == match.quantity_wh

    assert record.delivered_wh == match.quantity_wh

    assert record.seller_id == match.seller_id

    assert record.buyer_id == match.buyer_id

    assert (
        record.trade_id
        == ActiveTrade.model_validate(active).trade_id
    )

    assert (
        record.on_chain_trade_id
        == active["onChainTradeId"]
    )


# ==================================================
# TEST 3 — Incomplete delivery reports a shortfall
# ==================================================

def test_incomplete_delivery_reports_shortfall(
    pipeline,
    tmp_path,
):

    match = pipeline["matching"].matches[0]

    active = fictional_active_trade(match)

    _, record = generate_delivery(
        tmp_path,
        active,
        "INCOMPLETE",
        delivered_wh=1000,
    )

    assert record.status == DeliveryStatus.INCOMPLETE

    assert record.expected_wh == 2125

    assert record.delivered_wh == 1000

    assert record.delivered_wh < record.expected_wh


# ==================================================
# TEST 4 — Invalid delivery evidence is late
# ==================================================

def test_invalid_delivery_is_outside_allowed_window(
    pipeline,
    tmp_path,
):

    active = fictional_active_trade(
        pipeline["matching"].matches[0]
    )

    _, record = generate_delivery(
        tmp_path,
        active,
        "INVALID",
    )

    assert record.status == DeliveryStatus.INVALID

    recorded_time = datetime.fromisoformat(
        record.time_slot.replace("Z", "+00:00")
    )

    deadline = datetime.fromisoformat(
        active["deliveryDeadline"].replace(
            "Z",
            "+00:00",
        )
    )

    assert recorded_time > deadline


# ==================================================
# TEST 5 — Missing delivery creates no evidence file
# ==================================================

def test_missing_delivery_creates_no_evidence(
    pipeline,
    tmp_path,
):

    active = fictional_active_trade(
        pipeline["matching"].matches[0]
    )

    process, record = generate_delivery(
        tmp_path,
        active,
        "MISSING",
    )

    assert record is None

    assert (
        "no record was written"
        in process.stdout
    )


# ==================================================
# TEST 6 — Delivery IDs remain deterministic
# ==================================================

def test_delivery_ids_are_stable_across_independent_runs(
    pipeline,
    tmp_path,
):

    active = fictional_active_trade(
        pipeline["matching"].matches[0]
    )

    _, first = generate_delivery(
        tmp_path,
        active,
        "SUCCESS",
        name="first",
    )

    _, second = generate_delivery(
        tmp_path,
        active,
        "SUCCESS",
        name="second",
    )

    assert first.delivery_id == second.delivery_id

    assert first == second


# ==================================================
# TEST 7 — Two matches have distinct simulated trades
# ==================================================

def test_two_matches_receive_distinct_fictional_trades(
    pipeline,
    tmp_path,
):

    records = []
    trade_ids = set()

    for number, match in enumerate(
        pipeline["matching"].matches,
        start=1,
    ):

        active = fictional_active_trade(
            match,
            number=number,
        )

        assert active["tradeId"] not in trade_ids

        trade_ids.add(active["tradeId"])

        _, record = generate_delivery(
            tmp_path,
            active,
            "SUCCESS",
            name=f"trade-{number}",
        )

        assert record.buyer_id == match.buyer_id

        assert record.expected_wh == match.quantity_wh

        records.append(record)

    assert len({
        record.delivery_id
        for record in records
    }) == 2

    assert len({
        record.on_chain_trade_id
        for record in records
    }) == 2

    assert len({
        record.buyer_id
        for record in records
    }) == 2


# ==================================================
# TEST 8 — Reject trades not awaiting delivery
# ==================================================

def test_non_active_trade_cannot_generate_delivery(
    pipeline,
    tmp_path,
):

    active = fictional_active_trade(
        pipeline["matching"].matches[0]
    )

    # A match cannot be delivered before the
    # fictional trade reaches AWAITING_DELIVERY.
    active["status"] = "CREATED"

    process, record = generate_delivery(
        tmp_path,
        active,
        "SUCCESS",
        expected_code=2,
    )

    assert record is None

    assert (
        "ERROR: Invalid delivery input"
        in process.stderr
    )
