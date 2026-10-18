
"""
Matching Engine command-line interface.

Usage:
    python -m matching_engine.cli \
        --input INPUT_JSON \
        --output OUTPUT_JSON \
        --config MATCHING_CONFIG_JSON

Accepted input formats:
- EnergySnapshot
- MatchingInput

Exit codes:
0 = success, including zero matches
1 = unexpected internal error
2 = invalid input or configuration
3 = output writing error

Diagnostics go to stderr.
MatchingOutput JSON is written only to the output file.
"""

import argparse
import json
import sys
import time

from pathlib import Path

from p2p_energy_shared import (
    EnergySnapshot,
    MatchingConfig,
    MatchingInput,
)

from matching_engine import __version__

from matching_engine.greedy import match_greedily
from matching_engine.output_builder import build_matching_output


def create_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="matching-engine",
        description=(
            "Match hourly electricity buyers and sellers."
        ),
    )

    parser.add_argument(
        "--version",
        action="version",
        version=f"matching-engine {__version__}",
    )

    parser.add_argument(
        "--input",
        type=Path,
        required=True,
        help="EnergySnapshot or MatchingInput JSON file",
    )

    parser.add_argument(
        "--output",
        type=Path,
        required=True,
        help="Destination MatchingOutput JSON file",
    )

    parser.add_argument(
        "--config",
        type=Path,
        required=True,
        help="Matching configuration JSON file",
    )

    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Explicitly replace an existing result",
    )

    return parser


# --------------------------------------------------
# 1. Read a JSON document
# --------------------------------------------------

def read_json(path: Path) -> dict:
    data = json.loads(
        path.read_text(encoding="utf-8")
    )

    if not isinstance(data, dict):
        raise ValueError(
            f"Expected a JSON object in {path}"
        )

    return data


# --------------------------------------------------
# 2. Load or construct MatchingInput
# --------------------------------------------------

def prepare_matching_input(
    data: dict,
    config: MatchingConfig,
) -> MatchingInput:
    """
    Detect input format by its version field.

    EnergySnapshot:
        Convert through our shared from_snapshot()
        method using the supplied configuration.

    MatchingInput:
        Validate the embedded matching parameters
        against the supplied configuration.
    """

    if not isinstance(data, dict):
        raise TypeError(
            "Input data must be a JSON object"
        )

    if not isinstance(config, MatchingConfig):
        raise TypeError(
            "config must be a MatchingConfig"
        )

    # ----------------------------------------------
    # A. Data Generator output
    # ----------------------------------------------

    if "generatorVersion" in data:
        snapshot = EnergySnapshot.model_validate(data)

        return MatchingInput.from_snapshot(
            snapshot,
            config,
        )

    # ----------------------------------------------
    # B. Already prepared backend matching input
    # ----------------------------------------------

    if "algorithmVersion" in data:
        matching_input = MatchingInput.model_validate(
            data
        )

        input_settings = matching_input.model_dump(
            mode="json",
            by_alias=True,
        )

        config_settings = config.model_dump(
            mode="json",
            by_alias=True,
        )

        # Refuse silently inconsistent configurations.
        for field in (
            "schemaVersion",
            "algorithmVersion",
            "maximumDistanceKm",
            "scoringWeights",
        ):
            if (
                input_settings.get(field)
                != config_settings.get(field)
            ):
                raise ValueError(
                    "MatchingInput and configuration "
                    f"disagree on {field}"
                )

        return matching_input

    raise ValueError(
        "Input must be an EnergySnapshot "
        "or a MatchingInput"
    )


# --------------------------------------------------
# 3. Save the validated output
# --------------------------------------------------

def save_matching_output(
    output,
    output_path: Path,
    overwrite: bool = False,
) -> Path:

    if type(overwrite) is not bool:
        raise TypeError(
            "overwrite must be a boolean"
        )

    content = output.model_dump_json(
        by_alias=True,
        indent=2,
    )

    output_path.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    # Exclusive creation is the default.
    # Never replace an existing result accidentally.
    mode = "w" if overwrite else "x"

    with output_path.open(
        mode,
        encoding="utf-8",
        newline="\n",
    ) as file:
        file.write(content)
        file.write("\n")

    return output_path


# --------------------------------------------------
# 4. Execute matching
# --------------------------------------------------

def run_matching(args) -> int:

    # Never overwrite our original input files,
    # even when --overwrite was explicitly supplied.
    if args.output.resolve() in {
        args.input.resolve(),
        args.config.resolve(),
    }:
        print(
            "ERROR: Output cannot replace input "
            "or configuration files",
            file=sys.stderr,
        )
        return 2

    # ----------------------------------------------
    # A. Validate JSON input and configuration
    # ----------------------------------------------

    try:
        input_data = read_json(args.input)

        config_data = read_json(args.config)

        matching_config = MatchingConfig.model_validate(
            config_data
        )

        matching_input = prepare_matching_input(
            input_data,
            matching_config,
        )

    except (OSError, ValueError, TypeError) as error:
        print(
            f"ERROR: Invalid matching input: {error}",
            file=sys.stderr,
        )
        return 2

    # ----------------------------------------------
    # B. Execute the matching algorithm
    # ----------------------------------------------

    try:
        start_ns = time.perf_counter_ns()

        plan = match_greedily(matching_input)

        elapsed_ms = max(
            0,
            (
                time.perf_counter_ns() - start_ns
            ) // 1_000_000,
        )

        result = build_matching_output(
            matching_input=matching_input,
            plan=plan,
            execution_time_ms=elapsed_ms,
        )

    except (ValueError, TypeError) as error:
        print(
            f"ERROR: Matching validation failed: {error}",
            file=sys.stderr,
        )
        return 2

    except Exception as error:
        print(
            f"ERROR: Internal matching error: {error}",
            file=sys.stderr,
        )
        return 1

    # ----------------------------------------------
    # C. Export the result
    # ----------------------------------------------

    try:
        saved_path = save_matching_output(
            result,
            args.output,
            overwrite=args.overwrite,
        )

    except OSError as error:
        print(
            f"ERROR: Cannot save matching output: {error}",
            file=sys.stderr,
        )
        return 3

    # ----------------------------------------------
    # D. Diagnostics only on stderr
    # ----------------------------------------------

    print(
        f"PASS: Matching completed for "
        f"{result.time_slot}",
        file=sys.stderr,
    )

    print(
        f"Matches: {len(result.matches)}",
        file=sys.stderr,
    )

    print(
        f"Unmatched buyers: "
        f"{len(result.unmatched_buyer_ids)}",
        file=sys.stderr,
    )

    print(
        f"Execution time: "
        f"{result.execution_time_ms} ms",
        file=sys.stderr,
    )

    print(
        f"Saved result: {saved_path}",
        file=sys.stderr,
    )

    return 0


# --------------------------------------------------
# 5. Main entry point
# --------------------------------------------------

def main(argv=None) -> int:
    parser = create_parser()
    args = parser.parse_args(argv)

    return run_matching(args)


if __name__ == "__main__":
    raise SystemExit(main())
