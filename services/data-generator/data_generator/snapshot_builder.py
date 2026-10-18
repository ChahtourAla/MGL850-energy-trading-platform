
"""
Build complete, validated hourly energy snapshots.

Combines:
- Backend-enriched user registry
- Energy simulation configuration
- Production and consumption
- Market role classification
- Production source assignment
- Market price generation

No blockchain transactions or private keys are used.
"""

import hashlib
import json
from uuid import UUID, NAMESPACE_URL, uuid5

from p2p_energy_shared import (
    EnergySnapshot,
    HourlyEnergyRecord,
    UserRegistry,
)

from data_generator.energy_config import (
    EnergyGenerationConfig,
)
from data_generator.energy_simulator import (
    get_utc_hour,
    simulate_hourly_quantities,
)
from data_generator.market_roles import (
    classify_market_position,
)
from data_generator.market_terms import (
    assign_production_energy_type,
    generate_market_terms,
)


# --------------------------------------------------
# 1. Validate wallet readiness
# --------------------------------------------------

def _validate_snapshot_wallets(
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
            "Registry is missing blockchain wallet "
            f"information for {len(missing)} user(s)"
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
            "Duplicate Hedera account ID"
        )

    if len(evm_addresses) != len(set(evm_addresses)):
        raise ValueError(
            "Duplicate EVM address"
        )


# --------------------------------------------------
# 2. Generate a stable snapshot identifier
# --------------------------------------------------

def _build_snapshot_id(
    registry: UserRegistry,
    config: EnergyGenerationConfig,
    time_slot: str,
    consumption_only_user_ids: set[UUID],
) -> UUID:

    # Sort the users so the registry's input order
    # does not change the generated snapshot ID.
    users = sorted(
        registry.users,
        key=lambda user: str(user.user_id),
    )

    canonical_data = {
        "timeSlot": time_slot,
        "users": [
            user.model_dump(
                mode="json",
                by_alias=True,
                exclude_none=True,
            )
            for user in users
        ],
        "configuration": config.model_dump(
            mode="json",
            by_alias=True,
        ),
        "consumptionOnlyUserIds": sorted(
            str(user_id)
            for user_id in consumption_only_user_ids
        ),
    }

    # A canonical JSON representation ensures
    # that equal inputs produce equal IDs.
    encoded = json.dumps(
        canonical_data,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")

    fingerprint = hashlib.sha256(
        encoded
    ).hexdigest()

    return uuid5(
        NAMESPACE_URL,
        f"p2p-energy:snapshot:{fingerprint}",
    )


# --------------------------------------------------
# 3. Build the complete EnergySnapshot
# --------------------------------------------------

def build_energy_snapshot(
    registry: UserRegistry,
    time_slot: str,
    config: EnergyGenerationConfig,
    consumption_only_user_ids: set[UUID] | None = None,
) -> EnergySnapshot:
    """
    Generate one HourlyEnergyRecord per user.

    All user wallets must already have been supplied
    by the backend.

    By default, users are treated as having a
    production technology. The optional set identifies
    households that consume but do not generate locally.
    """

    # --------------------------------------------------
    # 4. Validate arguments
    # --------------------------------------------------

    if not isinstance(registry, UserRegistry):
        raise TypeError(
            "registry must be a UserRegistry"
        )

    if not isinstance(config, EnergyGenerationConfig):
        raise TypeError(
            "config must be an EnergyGenerationConfig"
        )

    get_utc_hour(time_slot)

    if registry.schema_version != config.schema_version:
        raise ValueError(
            "Registry and energy configuration "
            "schema versions differ"
        )

    _validate_snapshot_wallets(registry)

    # --------------------------------------------------
    # 5. Validate consumption-only household IDs
    # --------------------------------------------------

    if consumption_only_user_ids is None:
        consumption_only_user_ids = set()

    elif not isinstance(
        consumption_only_user_ids,
        (set, frozenset),
    ):
        raise TypeError(
            "consumption_only_user_ids must be a set"
        )

    if not all(
        isinstance(user_id, UUID)
        for user_id in consumption_only_user_ids
    ):
        raise TypeError(
            "consumption_only_user_ids must contain UUIDs"
        )

    registered_ids = {
        user.user_id
        for user in registry.users
    }

    unknown_ids = (
        consumption_only_user_ids - registered_ids
    )

    if unknown_ids:
        raise ValueError(
            "Unknown consumption-only user IDs"
        )

    # --------------------------------------------------
    # 6. Deterministic snapshot and record IDs
    # --------------------------------------------------

    snapshot_id = _build_snapshot_id(
        registry,
        config,
        time_slot,
        consumption_only_user_ids,
    )

    records = []

    # Sort users to make output ordering reproducible.
    users = sorted(
        registry.users,
        key=lambda user: str(user.user_id),
    )

    # --------------------------------------------------
    # 7. Simulate every registered household
    # --------------------------------------------------

    for user in users:

        has_local_generation = (
            user.user_id not in consumption_only_user_ids
        )

        production_source = (
            assign_production_energy_type(
                user=user,
                config=config,
                has_local_generation=has_local_generation,
            )
        )

        # Step 7: simulate electricity quantities.
        quantities = simulate_hourly_quantities(
            user=user,
            time_slot=time_slot,
            config=config,
            energy_type=production_source,
        )

        # Step 8: classify SELLER, BUYER, or NEUTRAL.
        position = classify_market_position(
            quantities
        )

        # Step 9: generate the market offer.
        terms = generate_market_terms(
            user=user,
            time_slot=time_slot,
            config=config,
            position=position,
            production_energy_type=production_source,
        )

        # Stable, unique record ID within the snapshot.
        record_id = uuid5(
            snapshot_id,
            str(user.user_id),
        )

        # ----------------------------------------------
        # 8. Construct a validated hourly record
        # ----------------------------------------------

        record = HourlyEnergyRecord(
            recordId=record_id,
            userId=user.user_id,
            timeSlot=time_slot,
            productionWh=quantities.production_wh,
            consumptionWh=quantities.consumption_wh,
            netEnergyWh=position.net_energy_wh,
            marketRole=position.market_role,
            availableEnergyWh=position.available_energy_wh,
            requiredEnergyWh=position.required_energy_wh,
            energyType=terms.energy_type,
            askPriceMicrousdPerKwh=(
                terms.ask_price_microusd_per_kwh
            ),
            maxPriceMicrousdPerKwh=(
                terms.max_price_microusd_per_kwh
            ),
            xKm=user.x_km,
            yKm=user.y_km,
            reputation=user.reputation,
            preferredEnergyType=(
                user.preferred_energy_type
            ),
            evmAddress=user.evm_address,
        )

        records.append(record)

    # --------------------------------------------------
    # 9. Return a validated EnergySnapshot
    # --------------------------------------------------

    return EnergySnapshot(
        schemaVersion=config.schema_version,
        snapshotId=snapshot_id,
        timeSlot=time_slot,
        generatorVersion=config.generator_version,
        users=records,
    )
