
"""
Command-line interface for the Energy Data Generator.

Commands:
- generate-users
- validate-users
- generate-snapshot
"""

import argparse
import sys

from pathlib import Path
from uuid import UUID

from p2p_energy_shared import UserRegistry

from data_generator import __version__

from data_generator.registry import (
    load_user_registry,
)

from data_generator.user_generator import (
    generate_user_registry,
    load_generation_config,
    save_user_registry,
)

from data_generator.energy_config import (
    load_energy_config,
)

from data_generator.snapshot_builder import (
    build_energy_snapshot,
)

from data_generator.snapshot_io import (
    save_energy_snapshot,
)


# --------------------------------------------------
# 1. Validate backend-enriched wallet information
# --------------------------------------------------

def validate_wallet_readiness(
    registry: UserRegistry,
) -> None:

    missing = [
        user
        for user in registry.users
        if (
            user.hedera_account_id is None
            or user.evm_address is None
        )
    ]

    if missing:
        raise ValueError(
            f"{len(missing)} user(s) are missing "
            "blockchain wallet information"
        )

    hedera_ids = [
        user.hedera_account_id
        for user in registry.users
    ]

    evm_addresses = [
        user.evm_address.lower()
        for user in registry.users
    ]

    if len(hedera_ids) != len(set(hedera_ids)):
        raise ValueError(
            "Duplicate Hedera account ID in user registry"
        )

    if len(evm_addresses) != len(set(evm_addresses)):
        raise ValueError(
            "Duplicate EVM address in user registry"
        )


# --------------------------------------------------
# 2. Define CLI arguments
# --------------------------------------------------

def create_parser() -> argparse.ArgumentParser:

    parser = argparse.ArgumentParser(
        prog="data-generator",
        description=(
            "Manage simulated users and generate "
            "hourly electricity snapshots."
        ),
    )

    parser.add_argument(
        "--version",
        action="version",
        version=f"data-generator {__version__}",
    )

    commands = parser.add_subparsers(
        dest="command",
    )

    # ----------------------------------------------
    # Command A: generate-users
    # ----------------------------------------------

    generate_parser = commands.add_parser(
        "generate-users",
        help="Generate a reproducible static user registry",
    )

    generate_parser.add_argument(
        "--config",
        type=Path,
        required=True,
        help="User generation configuration JSON",
    )

    generate_parser.add_argument(
        "--output",
        type=Path,
        required=True,
        help="Generated registry output path",
    )

    generate_parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Replace an existing registry",
    )

    # ----------------------------------------------
    # Command B: validate-users
    # ----------------------------------------------

    validate_parser = commands.add_parser(
        "validate-users",
        help="Validate an existing user registry",
    )

    validate_parser.add_argument(
        "--input",
        type=Path,
        required=True,
        help="User registry JSON file",
    )

    validate_parser.add_argument(
        "--require-wallets",
        action="store_true",
        help="Require unique blockchain wallet identifiers",
    )

    # ----------------------------------------------
    # Command C: generate-snapshot
    # ----------------------------------------------

    snapshot_parser = commands.add_parser(
        "generate-snapshot",
        help="Generate a validated hourly EnergySnapshot",
    )

    snapshot_parser.add_argument(
        "--registry",
        type=Path,
        required=True,
        help="Backend-enriched user registry JSON",
    )

    snapshot_parser.add_argument(
        "--config",
        type=Path,
        required=True,
        help="Energy generation configuration JSON",
    )

    snapshot_parser.add_argument(
        "--time-slot",
        type=str,
        required=True,
        help="UTC hour, such as 2026-10-18T12:00:00Z",
    )

    snapshot_parser.add_argument(
        "--output-dir",
        type=Path,
        required=True,
        help="Directory for generated snapshot files",
    )

    snapshot_parser.add_argument(
        "--consumption-only-user-id",
        type=UUID,
        action="append",
        default=None,
        help=(
            "UUID of a household without local generation. "
            "Repeat for multiple households."
        ),
    )

    snapshot_parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Replace an existing snapshot for this hour",
    )

    return parser


# --------------------------------------------------
# 3. Generate static users
# --------------------------------------------------

def run_generate_users(args) -> int:

    try:
        config = load_generation_config(
            args.config
        )

        registry = generate_user_registry(
            config
        )

    except (OSError, ValueError) as error:
        print(
            f"ERROR: {error}",
            file=sys.stderr,
        )
        return 2

    try:
        saved_path = save_user_registry(
            registry,
            args.output,
            overwrite=args.overwrite,
        )

    except OSError as error:
        print(
            f"ERROR: Could not save registry: {error}",
            file=sys.stderr,
        )
        return 3

    print(
        f"PASS: generated {len(registry.users)} users"
    )

    print(
        f"Saved registry: {saved_path}"
    )

    print(
        "Wallets: not generated; "
        "backend onboarding is required"
    )

    return 0


# --------------------------------------------------
# 4. Validate static or enriched user registries
# --------------------------------------------------

def run_validate_users(args) -> int:

    try:
        registry = load_user_registry(
            args.input
        )

        if args.require_wallets:
            validate_wallet_readiness(registry)

    except (OSError, ValueError) as error:
        print(
            f"ERROR: {error}",
            file=sys.stderr,
        )
        return 2

    print(
        f"PASS: registry contains "
        f"{len(registry.users)} valid users"
    )

    if args.require_wallets:

        print(
            "PASS: all users have unique "
            "Hedera accounts and EVM addresses"
        )

    else:

        wallet_count = sum(
            1
            for user in registry.users
            if (
                user.hedera_account_id is not None
                and user.evm_address is not None
            )
        )

        print(
            f"Wallet-ready users: "
            f"{wallet_count}/{len(registry.users)}"
        )

    return 0


# --------------------------------------------------
# 5. Generate a complete hourly energy snapshot
# --------------------------------------------------

def run_generate_snapshot(args) -> int:

    # ----------------------------------------------
    # A. Load and validate the input data
    # ----------------------------------------------

    try:
        registry = load_user_registry(
            args.registry
        )

        config = load_energy_config(
            args.config
        )

        consumption_only_ids = set(
            args.consumption_only_user_id or []
        )

        snapshot = build_energy_snapshot(
            registry=registry,
            time_slot=args.time_slot,
            config=config,
            consumption_only_user_ids=consumption_only_ids,
        )

    except (OSError, ValueError, TypeError) as error:
        print(
            f"ERROR: Cannot generate snapshot: {error}",
            file=sys.stderr,
        )
        return 2

    # ----------------------------------------------
    # B. Save validated snapshot to JSON
    # ----------------------------------------------

    try:
        output_path = save_energy_snapshot(
            snapshot=snapshot,
            output_dir=args.output_dir,
            overwrite=args.overwrite,
        )

    except OSError as error:
        print(
            f"ERROR: Could not save snapshot: {error}",
            file=sys.stderr,
        )
        return 3

    # ----------------------------------------------
    # C. Summarize the generated market
    # ----------------------------------------------

    seller_count = sum(
        record.market_role.value == "SELLER"
        for record in snapshot.users
    )

    buyer_count = sum(
        record.market_role.value == "BUYER"
        for record in snapshot.users
    )

    neutral_count = sum(
        record.market_role.value == "NEUTRAL"
        for record in snapshot.users
    )

    print(
        f"PASS: generated snapshot for {snapshot.time_slot}"
    )

    print(
        f"Users: {len(snapshot.users)}"
    )

    print(
        f"Market roles: {seller_count} sellers, "
        f"{buyer_count} buyers, "
        f"{neutral_count} neutral"
    )

    print(
        f"Snapshot ID: {snapshot.snapshot_id}"
    )

    print(
        f"Saved snapshot: {output_path}"
    )

    return 0


# --------------------------------------------------
# 6. Main CLI entry point
# --------------------------------------------------

def main(argv=None) -> int:

    parser = create_parser()

    args = parser.parse_args(argv)

    if args.command == "generate-users":
        return run_generate_users(args)

    if args.command == "validate-users":
        return run_validate_users(args)

    if args.command == "generate-snapshot":
        return run_generate_snapshot(args)

    # Preserve the no-command behavior
    # from our initial package setup.
    print(
        "Data Generator CLI is ready. "
        "Energy simulation is not implemented yet."
    )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
