
"""
End-to-end Data Generator -> Matching Engine tests.

Uses real Python subprocesses and JSON files to
verify both independent services together.

Controlled scenario:
- 12 households
- 1 solar generator
- 11 consumption-only households
- No random energy variation
- Fixed energy prices
- Nearby geographic coordinates
- Test-only fictional wallet identifiers

No real blockchain accounts or transactions.
"""

import json
import math
import subprocess
import sys

from collections import defaultdict
from pathlib import Path

import pytest

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

from p2p_energy_shared import (
    EnergySnapshot,
    MatchingConfig,
    MatchingInput,
    MatchingOutput,
    MarketRole,
)


# --------------------------------------------------
# 1. Repository paths
# --------------------------------------------------

ROOT = Path(__file__).resolve().parents[3]

DATA_GENERATOR_DIR = (
    ROOT / "services" / "data-generator"
)

SHARED_DIR = ROOT / "packages" / "shared"

USER_CONFIG = (
    DATA_GENERATOR_DIR
    / "config"
    / "user-registry-config.json"
)

ENERGY_CONFIG = (
    DATA_GENERATOR_DIR
    / "config"
    / "energy-generation-config.json"
)

MATCHING_CONFIG = (
    SHARED_DIR
    / "fixtures"
    / "matching-config.sample.json"
)

SCHEMAS_DIR = SHARED_DIR / "schemas"

MIDDAY = "2026-10-18T12:00:00Z"
EVENING = "2026-10-18T20:00:00Z"


# --------------------------------------------------
# 2. Execute either Python service
# --------------------------------------------------

def run_cli(module: str, *arguments):
    """
    Launch a real Python subprocess.

    Each service executes independently, just
    as it will during backend integration.
    """

    return subprocess.run(
        [
            sys.executable,
            "-m",
            module,
            *map(str, arguments),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )


def assert_success(process):
    assert process.returncode == 0, (
        f"Exit code: {process.returncode}\n"
        f"STDOUT:\n{process.stdout}\n"
        f"STDERR:\n{process.stderr}"
    )


def read_json(path):
    return json.loads(
        Path(path).read_text(encoding="utf-8")
    )


def write_json(path, value):
    Path(path).write_text(
        json.dumps(value, indent=2) + "\n",
        encoding="utf-8",
    )


# --------------------------------------------------
# 3. Generate the controlled user population
# --------------------------------------------------

@pytest.fixture(scope="module")
def scenario(tmp_path_factory):
    """
    Set up the complete testing environment once.

    Generate 12 users through the real Data Generator
    CLI, enrich them with fictional wallet identifiers,
    and prepare a deterministic energy configuration.
    """

    directory = tmp_path_factory.mktemp(
        "p2p_full_integration"
    )

    static_path = directory / "static-users.json"
    enriched_path = directory / "enriched-users.json"
    energy_config_path = directory / "energy-config.json"

    # ----------------------------------------------
    # A. Generate the static user registry
    # ----------------------------------------------

    result = run_cli(
        "data_generator.cli",
        "generate-users",
        "--config", USER_CONFIG,
        "--output", static_path,
    )

    assert_success(result)

    static_data = read_json(static_path)

    assert len(static_data["users"]) == 12

    # ----------------------------------------------
    # B. Add TEST-ONLY wallet identifiers
    # ----------------------------------------------

    enriched = json.loads(
        json.dumps(static_data)
    )

    for index, user in enumerate(
        enriched["users"],
        start=1,
    ):
        user["hederaAccountId"] = (
            f"0.0.{950000 + index}"
        )

        user["evmAddress"] = (
            f"0x{index:040x}"
        )

        # Keep households close together so all
        # possible trades satisfy the distance rule.
        user["xKm"] = 2.0 + index * 0.05
        user["yKm"] = 2.0 + index * 0.05

        # Consumption-only households accept any
        # production source.
        if index > 1:
            user["preferredEnergyType"] = "ANY"

    write_json(enriched_path, enriched)

    # ----------------------------------------------
    # C. Validate wallet-enriched users
    # ----------------------------------------------

    validation = run_cli(
        "data_generator.cli",
        "validate-users",
        "--input", enriched_path,
        "--require-wallets",
    )

    assert_success(validation)

    # ----------------------------------------------
    # D. Configure a predictable energy market
    # ----------------------------------------------

    config = read_json(ENERGY_CONFIG)

    # The producing household will use SOLAR.
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

    write_json(energy_config_path, config)

    # The first user has solar generation.
    # All remaining users consume only.
    consumer_ids = [
        user["userId"]
        for user in enriched["users"][1:]
    ]

    return {
        "directory": directory,
        "static_path": static_path,
        "enriched_path": enriched_path,
        "energy_config_path": energy_config_path,
        "matching_config_path": MATCHING_CONFIG,
        "consumer_ids": consumer_ids,
    }


# --------------------------------------------------
# 4. Execute the complete two-service workflow
# --------------------------------------------------

def run_pipeline(
    scenario,
    time_slot,
    label,
):
    """
    Run:
        Data Generator -> EnergySnapshot JSON
        Matching Engine -> MatchingOutput JSON
    """

    work = scenario["directory"] / label
    snapshot_dir = work / "snapshots"
    matching_path = work / "matching-output.json"

    arguments = [
        "generate-snapshot",
        "--registry", scenario["enriched_path"],
        "--config", scenario["energy_config_path"],
        "--time-slot", time_slot,
        "--output-dir", snapshot_dir,
    ]

    for user_id in scenario["consumer_ids"]:
        arguments += [
            "--consumption-only-user-id",
            user_id,
        ]

    generation = run_cli(
        "data_generator.cli",
        *arguments,
    )

    assert_success(generation)

    snapshot_path = (
        snapshot_dir
        / f"energy_snapshot_{time_slot[:13]}.json"
    )

    assert snapshot_path.is_file()

    matching = run_cli(
        "matching_engine.cli",
        "--input", snapshot_path,
        "--config", scenario["matching_config_path"],
        "--output", matching_path,
    )

    assert_success(matching)

    assert matching_path.is_file()

    return {
        "snapshot_path": snapshot_path,
        "matching_path": matching_path,
        "generation": generation,
        "matching": matching,
        "snapshot": EnergySnapshot.model_validate_json(
            snapshot_path.read_text(encoding="utf-8")
        ),
        "output": MatchingOutput.model_validate_json(
            matching_path.read_text(encoding="utf-8")
        ),
    }


@pytest.fixture(scope="module")
def midday_pipeline(scenario):
    return run_pipeline(
        scenario,
        MIDDAY,
        "midday",
    )


@pytest.fixture(scope="module")
def evening_pipeline(scenario):
    return run_pipeline(
        scenario,
        EVENING,
        "evening",
    )


# --------------------------------------------------
# 5. Validate against our actual shared JSON Schemas
# --------------------------------------------------

def validate_shared_schema(data, filename):

    registry = Registry()

    for path in sorted(
        SCHEMAS_DIR.glob("*.schema.json")
    ):
        schema = read_json(path)

        registry = registry.with_resource(
            schema["$id"],
            Resource.from_contents(schema),
        )

    validator = Draft202012Validator(
        read_json(SCHEMAS_DIR / filename),
        registry=registry,
        format_checker=FormatChecker(),
    )

    validator.validate(data)


# ==================================================
# TEST 1 — Complete user onboarding prerequisites
# ==================================================

def test_user_generation_and_wallet_enrichment(scenario):

    static = read_json(scenario["static_path"])
    enriched = read_json(scenario["enriched_path"])

    assert len(static["users"]) == 12
    assert len(enriched["users"]) == 12

    assert all(
        "evmAddress" not in user
        and "hederaAccountId" not in user
        for user in static["users"]
    )

    assert len({
        user["evmAddress"]
        for user in enriched["users"]
    }) == 12

    assert len({
        user["hederaAccountId"]
        for user in enriched["users"]
    }) == 12


# ==================================================
# TEST 2 — Midday roles and energy quantities
# ==================================================

def test_midday_has_one_seller_and_eleven_buyers(
    midday_pipeline,
):

    snapshot = midday_pipeline["snapshot"]

    assert len(snapshot.users) == 12

    sellers = [
        user for user in snapshot.users
        if user.market_role == MarketRole.SELLER
    ]

    buyers = [
        user for user in snapshot.users
        if user.market_role == MarketRole.BUYER
    ]

    assert len(sellers) == 1
    assert len(buyers) == 11

    seller = sellers[0]

    assert seller.production_wh == 6500
    assert seller.consumption_wh == 2125
    assert seller.available_energy_wh == 4375

    assert seller.energy_type.value == "SOLAR"

    for buyer in buyers:
        assert buyer.production_wh == 0
        assert buyer.required_energy_wh == 2125


# ==================================================
# TEST 3 — Two successful matches, nine unmatched
# ==================================================

def test_end_to_end_matching_results(midday_pipeline):

    output = midday_pipeline["output"]

    assert len(output.matches) == 2
    assert len(output.unmatched_buyer_ids) == 9

    assert all(
        match.quantity_wh == 2125
        for match in output.matches
    )


# ==================================================
# TEST 4 — Each buyer is fully matched at most once
# ==================================================

def test_matched_buyers_are_fully_fulfilled(
    midday_pipeline,
):

    snapshot = midday_pipeline["snapshot"]
    output = midday_pipeline["output"]

    buyers = {
        user.user_id: user
        for user in snapshot.users
        if user.market_role == MarketRole.BUYER
    }

    matched_ids = [
        match.buyer_id
        for match in output.matches
    ]

    assert len(matched_ids) == len(set(matched_ids))

    for match in output.matches:
        assert match.buyer_id in buyers
        assert (
            match.quantity_wh
            == buyers[match.buyer_id].required_energy_wh
        )

    assert set(matched_ids).isdisjoint(
        output.unmatched_buyer_ids
    )

    assert (
        set(matched_ids)
        | set(output.unmatched_buyer_ids)
    ) == set(buyers)


# ==================================================
# TEST 5 — The seller is never oversold
# ==================================================

def test_seller_energy_conservation(midday_pipeline):

    snapshot = midday_pipeline["snapshot"]
    output = midday_pipeline["output"]

    sellers = {
        user.user_id: user
        for user in snapshot.users
        if user.market_role == MarketRole.SELLER
    }

    allocated = defaultdict(int)

    for match in output.matches:
        assert match.seller_id in sellers
        allocated[match.seller_id] += (
            match.quantity_wh
        )

    for seller_id, seller in sellers.items():
        assert (
            allocated[seller_id]
            <= seller.available_energy_wh
        )

    assert sum(allocated.values()) == 4250

    seller = next(iter(sellers.values()))

    assert (
        seller.available_energy_wh
        - allocated[seller.user_id]
    ) == 125


# ==================================================
# TEST 6 — Correct prices and payment amounts
# ==================================================

def test_matching_prices_and_payments(
    midday_pipeline,
):

    output = midday_pipeline["output"]

    for match in output.matches:
        assert match.unit_price_microusd_per_kwh == 140000
        assert match.quantity_wh == 2125
        assert match.total_amount_microusd == 297500

    assert sum(
        match.total_amount_microusd
        for match in output.matches
    ) == 595000


# ==================================================
# TEST 7 — Each match respects business constraints
# ==================================================

def test_matching_respects_eligibility_rules(
    midday_pipeline,
    scenario,
):

    snapshot = midday_pipeline["snapshot"]
    output = midday_pipeline["output"]

    users = {
        user.user_id: user
        for user in snapshot.users
    }

    config = MatchingConfig.model_validate(
        read_json(scenario["matching_config_path"])
    )

    for match in output.matches:
        buyer = users[match.buyer_id]
        seller = users[match.seller_id]

        assert buyer.market_role == MarketRole.BUYER
        assert seller.market_role == MarketRole.SELLER
        assert buyer.user_id != seller.user_id

        assert match.buyer_wallet == buyer.evm_address
        assert match.seller_wallet == seller.evm_address

        assert (
            match.unit_price_microusd_per_kwh
            <= buyer.max_price_microusd_per_kwh
        )

        assert buyer.preferred_energy_type.value in (
            "ANY",
            seller.energy_type.value,
        )

        expected_distance = math.hypot(
            buyer.x_km - seller.x_km,
            buyer.y_km - seller.y_km,
        )

        assert match.distance_km == pytest.approx(
            expected_distance
        )

        assert (
            match.distance_km
            <= config.maximum_distance_km
        )

        assert 0 <= match.score <= 1


# ==================================================
# TEST 8 — Metadata and stable match IDs
# ==================================================

def test_matching_output_metadata(
    midday_pipeline,
    scenario,
):

    snapshot = midday_pipeline["snapshot"]
    output = midday_pipeline["output"]

    config = MatchingConfig.model_validate(
        read_json(scenario["matching_config_path"])
    )

    assert output.snapshot_id == snapshot.snapshot_id
    assert output.time_slot == snapshot.time_slot
    assert output.schema_version == snapshot.schema_version
    assert output.algorithm_version == config.algorithm_version

    assert isinstance(
        output.execution_time_ms,
        (int, float),
    )

    assert math.isfinite(output.execution_time_ms)
    assert output.execution_time_ms >= 0

    assert output.warnings == []

    ids = [match.match_id for match in output.matches]

    assert len(ids) == len(set(ids))

    for match in output.matches:
        assert match.created_at.endswith("Z")
        assert match.time_slot == snapshot.time_slot
        assert match.algorithm_version == output.algorithm_version


# ==================================================
# TEST 9 — Both JSON files follow shared schemas
# ==================================================

def test_both_exported_json_files_match_schemas(
    midday_pipeline,
):

    snapshot = read_json(
        midday_pipeline["snapshot_path"]
    )

    matching = read_json(
        midday_pipeline["matching_path"]
    )

    validate_shared_schema(
        snapshot,
        "energy-snapshot.schema.json",
    )

    validate_shared_schema(
        matching,
        "matching-output.schema.json",
    )


# ==================================================
# TEST 10 — Evening with no sellers is successful
# ==================================================

def test_evening_no_match_market(evening_pipeline):

    snapshot = evening_pipeline["snapshot"]
    output = evening_pipeline["output"]

    assert len(snapshot.users) == 12

    assert all(
        user.market_role == MarketRole.BUYER
        for user in snapshot.users
    )

    assert output.matches == []

    assert len(output.unmatched_buyer_ids) == 12

    assert set(output.unmatched_buyer_ids) == {
        user.user_id for user in snapshot.users
    }

    assert output.snapshot_id == snapshot.snapshot_id


# ==================================================
# TEST 11 — Match IDs stable across independent runs
# ==================================================

def test_match_ids_stable_across_processes(
    midday_pipeline,
    scenario,
    tmp_path,
):

    new_output_path = tmp_path / "second-run.json"

    process = run_cli(
        "matching_engine.cli",
        "--input", midday_pipeline["snapshot_path"],
        "--config", scenario["matching_config_path"],
        "--output", new_output_path,
    )

    assert_success(process)

    repeated = MatchingOutput.model_validate_json(
        new_output_path.read_text(encoding="utf-8")
    )

    original = midday_pipeline["output"]

    assert [
        match.match_id for match in repeated.matches
    ] == [
        match.match_id for match in original.matches
    ]

    assert [
        match.quantity_wh for match in repeated.matches
    ] == [
        match.quantity_wh for match in original.matches
    ]

    assert (
        repeated.unmatched_buyer_ids
        == original.unmatched_buyer_ids
    )

    # createdAt and executionTimeMs may differ.


# ==================================================
# TEST 12 — Prepared MatchingInput produces same trades
# ==================================================

def test_prepared_matching_input_is_equivalent(
    midday_pipeline,
    scenario,
    tmp_path,
):

    snapshot = midday_pipeline["snapshot"]

    config = MatchingConfig.model_validate(
        read_json(scenario["matching_config_path"])
    )

    matching_input = MatchingInput.from_snapshot(
        snapshot,
        config,
    )

    prepared_path = tmp_path / "prepared-input.json"
    output_path = tmp_path / "prepared-output.json"

    prepared_path.write_text(
        matching_input.model_dump_json(
            by_alias=True,
            indent=2,
        ),
        encoding="utf-8",
    )

    process = run_cli(
        "matching_engine.cli",
        "--input", prepared_path,
        "--config", scenario["matching_config_path"],
        "--output", output_path,
    )

    assert_success(process)

    prepared_output = MatchingOutput.model_validate_json(
        output_path.read_text(encoding="utf-8")
    )

    original = midday_pipeline["output"]

    assert [
        match.match_id
        for match in prepared_output.matches
    ] == [
        match.match_id
        for match in original.matches
    ]

    assert (
        prepared_output.unmatched_buyer_ids
        == original.unmatched_buyer_ids
    )


# ==================================================
# TEST 13 — Matching does not modify snapshot files
# ==================================================

def test_matching_keeps_input_snapshot_unchanged(
    midday_pipeline,
    scenario,
    tmp_path,
):

    path = midday_pipeline["snapshot_path"]

    original_bytes = path.read_bytes()

    process = run_cli(
        "matching_engine.cli",
        "--input", path,
        "--config", scenario["matching_config_path"],
        "--output", tmp_path / "result.json",
    )

    assert_success(process)

    assert path.read_bytes() == original_bytes
    assert process.stdout == ""
    assert "PASS: Matching completed" in process.stderr


# ==================================================
# TEST 14 — No affordable seller is a valid no-match
# ==================================================

def test_unaffordable_energy_creates_no_matches(
    midday_pipeline,
    scenario,
    tmp_path,
):

    snapshot_data = read_json(
        midday_pipeline["snapshot_path"]
    )

    # Simulate buyers who cannot afford the
    # seller's price in a test-only snapshot.
    for user in snapshot_data["users"]:
        if user["marketRole"] == "BUYER":
            user["maxPriceMicrousdPerKwh"] = 100000

    adjusted_snapshot = (
        tmp_path / "unaffordable-snapshot.json"
    )

    adjusted_output = (
        tmp_path / "unaffordable-matching.json"
    )

    write_json(adjusted_snapshot, snapshot_data)

    process = run_cli(
        "matching_engine.cli",
        "--input", adjusted_snapshot,
        "--config", scenario["matching_config_path"],
        "--output", adjusted_output,
    )

    assert_success(process)

    output = MatchingOutput.model_validate_json(
        adjusted_output.read_text(encoding="utf-8")
    )

    assert output.matches == []
    assert len(output.unmatched_buyer_ids) == 11
