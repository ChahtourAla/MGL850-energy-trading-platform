
"""Handler for the generate-delivery CLI command."""

import sys

from data_generator.delivery_io import (
    load_active_trade,
    load_delivery_config,
    save_delivery_record,
)

from data_generator.delivery_simulator import (
    simulate_delivery,
)


def run_generate_delivery(args) -> int:
    """
    Exit codes:
    0 = successful simulation
    2 = invalid input or configuration
    3 = output conflict or writing error
    """

    # Never overwrite the trade or configuration file.
    if args.output.resolve() in {
        args.input.resolve(),
        args.config.resolve(),
    }:
        print(
            "ERROR: Output must differ from input and config",
            file=sys.stderr,
        )
        return 2

    # ----------------------------------------------
    # A. Load and validate the inputs
    # ----------------------------------------------

    try:
        trade = load_active_trade(args.input)
        config = load_delivery_config(args.config)

        record = simulate_delivery(
            trade,
            config.scenario,
            delivered_wh=config.delivered_wh,
            reported_at=config.reported_at,
        )

    except (OSError, ValueError, TypeError) as error:
        print(
            f"ERROR: Invalid delivery input: {error}",
            file=sys.stderr,
        )
        return 2

    # ----------------------------------------------
    # B. Handle missing delivery
    # ----------------------------------------------

    if record is None:

        # No DeliveryRecord should exist for MISSING.
        # Reject an existing output file so stale data
        # cannot be mistaken for fresh evidence.
        if args.output.exists():
            print(
                "ERROR: MISSING must not leave an existing output file; "
                "choose a new output path or remove the stale file manually",
                file=sys.stderr,
            )
            return 3

        print(
            "PASS: MISSING delivery simulated; "
            "no record was written"
        )
        return 0

    # ----------------------------------------------
    # C. Export the delivery record
    # ----------------------------------------------

    try:
        saved = save_delivery_record(
            record,
            args.output,
            overwrite=args.overwrite,
        )

    except OSError as error:
        print(
            f"ERROR: Could not write delivery record: {error}",
            file=sys.stderr,
        )
        return 3

    # ----------------------------------------------
    # D. Print execution summary
    # ----------------------------------------------

    print(
        f"PASS: delivery simulated ({record.status.value})"
    )

    print(
        f"Delivery ID: {record.delivery_id}"
    )

    print(
        f"Saved delivery: {saved}"
    )

    return 0
