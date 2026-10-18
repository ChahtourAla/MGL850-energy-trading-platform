
"""
Standalone Python-services backend handoff smoke test.

Run from the repository root:

    .venv\\Scripts\\python.exe scripts/check_python_handoff.py

Verifies the real Data Generator and Matching Engine
CLI processes using temporary JSON files.

No real wallet creation, database or blockchain access.
"""

import json
import subprocess
import sys
import tempfile

from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

from p2p_energy_shared import (
    EnergySnapshot,
    MatchingConfig,
    MatchingInput,
    MatchingOutput,
    MarketRole,
)


ROOT = Path(__file__).resolve().parents[1]

GENERATOR_CONFIG = (
    ROOT
    / "services"
    / "data-generator"
    / "config"
    / "user-registry-config.json"
)

ENERGY_CONFIG = (
    ROOT
    / "services"
    / "data-generator"
    / "config"
    / "energy-generation-config.json"
)

MATCHING_CONFIG = (
    ROOT
    / "packages"
    / "shared"
    / "fixtures"
    / "matching-config.sample.json"
)

SCHEMAS = ROOT / "packages" / "shared" / "schemas"

MIDDAY = "2026-10-18T12:00:00Z"
EVENING = "2026-10-18T20:00:00Z"


def read_json(path):
    return json.loads(
        Path(path).read_text(encoding="utf-8")
    )


def write_json(path, data):
    Path(path).write_text(
        json.dumps(data, indent=2) + "\n",
        encoding="utf-8",
    )


def run_cli(module, *arguments):
    command = [
        sys.executable,
        "-m",
        module,
        *map(str, arguments),
    ]

    try:
        result = subprocess.run(
            command,
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise RuntimeError(
            f"{module} exceeded the 30-second timeout"
        ) from error

    if result.returncode != 0:
        raise RuntimeError(
            f"{module} exited with {result.returncode}\n"
            f"STDOUT:\n{result.stdout}\n"
            f"STDERR:\n{result.stderr}"
        )

    return result


def check_schema(path, schema_name):
    registry = Registry()

    for candidate in sorted(
        SCHEMAS.glob("*.schema.json")
    ):
        schema = read_json(candidate)

        registry = registry.with_resource(
            schema["$id"],
            Resource.from_contents(schema),
        )

    validator = Draft202012Validator(
        read_json(SCHEMAS / schema_name),
        registry=registry,
        format_checker=FormatChecker(),
    )

    validator.validate(read_json(path))


def generate_snapshot(
    directory,
    registry_path,
    energy_config_path,
    consumer_ids,
    time_slot,
):
    output_dir = directory / "snapshots"

    args = [
        "generate-snapshot",
        "--registry", registry_path,
        "--config", energy_config_path,
        "--time-slot", time_slot,
        "--output-dir", output_dir,
    ]

    for user_id in consumer_ids:
        args += [
            "--consumption-only-user-id",
            user_id,
        ]

    run_cli("data_generator.cli", *args)

    snapshot_path = (
        output_dir
        / f"energy_snapshot_{time_slot[:13]}.json"
    )

    if not snapshot_path.is_file():
        raise RuntimeError(
            "Data Generator did not create the snapshot"
        )

    check_schema(
        snapshot_path,
        "energy-snapshot.schema.json",
    )

    snapshot = EnergySnapshot.model_validate_json(
        snapshot_path.read_text(encoding="utf-8")
    )

    return snapshot_path, snapshot


def execute_matching(
    input_path,
    output_path,
):
    result = run_cli(
        "matching_engine.cli",
        "--input", input_path,
        "--config", MATCHING_CONFIG,
        "--output", output_path,
    )

    if result.stdout:
        raise RuntimeError(
            "Matching Engine wrote unexpected stdout"
        )

    check_schema(
        output_path,
        "matching-output.schema.json",
    )

    return MatchingOutput.model_validate_json(
        output_path.read_text(encoding="utf-8")
    )


def main():
    with tempfile.TemporaryDirectory(
        prefix="p2p_backend_handoff_"
    ) as temporary:
        directory = Path(temporary)

        # ------------------------------------------
        # 1. Generate household profiles
        # ------------------------------------------

        static_path = directory / "static-users.json"

        run_cli(
            "data_generator.cli",
            "generate-users",
            "--config", GENERATOR_CONFIG,
            "--output", static_path,
        )

        registry = read_json(static_path)

        if len(registry["users"]) != 12:
            raise RuntimeError(
                "Expected 12 generated households"
            )

        # ------------------------------------------
        # 2. Add fictional wallet identifiers
        # ------------------------------------------

        for number, user in enumerate(
            registry["users"],
            start=1,
        ):
            user["hederaAccountId"] = (
                f"0.0.{980000 + number}"
            )

            user["evmAddress"] = (
                f"0x{number:040x}"
            )

            user["xKm"] = 2.0 + number * 0.05
            user["yKm"] = 2.0 + number * 0.05

            if number > 1:
                user["preferredEnergyType"] = "ANY"

        registry_path = directory / "enriched-users.json"

        write_json(registry_path, registry)

        run_cli(
            "data_generator.cli",
            "validate-users",
            "--input", registry_path,
            "--require-wallets",
        )

        consumer_ids = [
            user["userId"]
            for user in registry["users"][1:]
        ]

        # ------------------------------------------
        # 3. Prepare deterministic energy config
        # ------------------------------------------

        energy_config = read_json(ENERGY_CONFIG)

        energy_config["productionEnergyTypeWeights"] = {
            "SOLAR": 1.0,
            "WIND": 0.0,
            "HYDRO": 0.0,
            "GRID": 0.0,
            "MIXED": 0.0,
        }

        energy_config["productionVariationFraction"] = 0.0
        energy_config["consumptionVariationFraction"] = 0.0

        energy_config["sellerAskPriceRange"] = {
            "minMicrousdPerKwh": 140000,
            "maxMicrousdPerKwh": 140000,
        }

        energy_config["buyerMaxPriceRange"] = {
            "minMicrousdPerKwh": 170000,
            "maxMicrousdPerKwh": 170000,
        }

        energy_config_path = (
            directory / "energy-config.json"
        )

        write_json(energy_config_path, energy_config)

        # ------------------------------------------
        # 4. Generate a midday snapshot
        # ------------------------------------------

        midday_dir = directory / "midday"

        midday_path, midday_snapshot = generate_snapshot(
            midday_dir,
            registry_path,
            energy_config_path,
            consumer_ids,
            MIDDAY,
        )

        if len(midday_snapshot.users) != 12:
            raise RuntimeError(
                "Midday snapshot has the wrong user count"
            )

        # ------------------------------------------
        # 5. Match the midday market
        # ------------------------------------------

        midday_output = execute_matching(
            midday_path,
            directory / "midday-matches.json",
        )

        if (
            len(midday_output.matches) != 2
            or len(midday_output.unmatched_buyer_ids) != 9
        ):
            raise RuntimeError(
                "Unexpected midday matching results"
            )

        if (
            midday_output.snapshot_id
            != midday_snapshot.snapshot_id
        ):
            raise RuntimeError(
                "Snapshot ID mismatch"
            )

        sellers = {
            record.user_id: record
            for record in midday_snapshot.users
            if record.market_role == MarketRole.SELLER
        }

        allocated_by_seller = {
            seller_id: 0
            for seller_id in sellers
        }

        matched_buyers = set()

        for match in midday_output.matches:
            if match.buyer_id in matched_buyers:
                raise RuntimeError(
                    "Buyer matched more than once"
                )

            matched_buyers.add(match.buyer_id)

            if match.seller_id not in sellers:
                raise RuntimeError(
                    "Unknown matched seller"
                )

            if (
                match.quantity_wh != 2125
                or match.total_amount_microusd != 297500
            ):
                raise RuntimeError(
                    "Invalid matched energy or payment"
                )

            allocated_by_seller[match.seller_id] += (
                match.quantity_wh
            )

        for seller_id, allocated_wh in (
            allocated_by_seller.items()
        ):
            if (
                allocated_wh
                > sellers[seller_id].available_energy_wh
            ):
                raise RuntimeError(
                    "Seller inventory exceeded"
                )

        # ------------------------------------------
        # 6. Verify prepared MatchingInput contract
        # ------------------------------------------

        config = MatchingConfig.model_validate(
            read_json(MATCHING_CONFIG)
        )

        prepared = MatchingInput.from_snapshot(
            midday_snapshot,
            config,
        )

        prepared_path = directory / "prepared-input.json"

        prepared_path.write_text(
            prepared.model_dump_json(
                by_alias=True,
                indent=2,
            ),
            encoding="utf-8",
        )

        check_schema(
            prepared_path,
            "matching-input.schema.json",
        )

        prepared_output = execute_matching(
            prepared_path,
            directory / "prepared-matches.json",
        )

        if [
            match.match_id
            for match in prepared_output.matches
        ] != [
            match.match_id
            for match in midday_output.matches
        ]:
            raise RuntimeError(
                "MatchingInput and EnergySnapshot "
                "produced different matches"
            )

        # ------------------------------------------
        # 7. Verify a valid zero-match market
        # ------------------------------------------

        evening_dir = directory / "evening"

        evening_path, evening_snapshot = (
            generate_snapshot(
                evening_dir,
                registry_path,
                energy_config_path,
                consumer_ids,
                EVENING,
            )
        )

        evening_output = execute_matching(
            evening_path,
            directory / "evening-matches.json",
        )

        if (
            len(evening_output.matches) != 0
            or len(evening_output.unmatched_buyer_ids) != 12
        ):
            raise RuntimeError(
                "Zero-match market handled incorrectly"
            )

        if (
            evening_output.snapshot_id
            != evening_snapshot.snapshot_id
        ):
            raise RuntimeError(
                "Evening snapshot ID mismatch"
            )

        # ------------------------------------------
        # 8. Report readiness
        # ------------------------------------------

        print("PASS: Python services backend handoff")
        print("Households: 12")
        print("Midday matches: 2")
        print("Midday unmatched buyers: 9")
        print("Evening matches: 0")
        print("Evening unmatched buyers: 12")
        print("JSON Schemas: valid")
        print("Prepared MatchingInput: compatible")
        print("Seller energy conservation: valid")
        print("Temporary test files: automatically cleaned")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(
            f"FAIL: Python handoff check: {error}",
            file=sys.stderr,
        )
        raise SystemExit(1)
