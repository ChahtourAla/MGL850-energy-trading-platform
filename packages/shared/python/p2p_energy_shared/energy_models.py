
"""
Shared Pydantic models for hourly energy records
and energy snapshots.
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Annotated
from uuid import UUID

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StrictInt,
    model_validator,
)

from .models import PreferredEnergyType


# --------------------------------------------------
# 1. Validate hourly UTC timestamps
# --------------------------------------------------

def validate_hour_slot(value: str) -> str:
    """
    The timestamp must represent a real calendar date.
    The HourTimeSlot pattern enforces complete UTC hours.
    """
    try:
        datetime.strptime(
            value,
            "%Y-%m-%dT%H:%M:%SZ"
        )
    except ValueError as error:
        raise ValueError(
            "timeSlot must be a valid UTC date and hour"
        ) from error

    return value


# --------------------------------------------------
# 2. Reusable field types
# --------------------------------------------------

HourTimeSlot = Annotated[
    str,
    Field(
        strict=True,
        pattern=(
            r"^\d{4}-\d{2}-\d{2}T"
            r"(?:[01]\d|2[0-3]):00:00Z$"
        )
    ),
    AfterValidator(validate_hour_slot),
]

EnergyWh = Annotated[
    StrictInt,
    Field(ge=0)
]

PositivePrice = Annotated[
    StrictInt,
    Field(gt=0)
]

Reputation = Annotated[
    StrictInt,
    Field(ge=0, le=100)
]


# --------------------------------------------------
# 3. Energy types and market roles
# --------------------------------------------------

class EnergyType(str, Enum):
    SOLAR = "SOLAR"
    WIND = "WIND"
    HYDRO = "HYDRO"
    GRID = "GRID"
    MIXED = "MIXED"


class MarketRole(str, Enum):
    SELLER = "SELLER"
    BUYER = "BUYER"
    NEUTRAL = "NEUTRAL"


# --------------------------------------------------
# 4. HourlyEnergyRecord model
# --------------------------------------------------

class HourlyEnergyRecord(BaseModel):

    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        allow_inf_nan=False,
    )

    # Identification
    record_id: UUID = Field(alias="recordId")
    user_id: UUID = Field(alias="userId")
    time_slot: HourTimeSlot = Field(alias="timeSlot")

    # Energy quantities
    production_wh: EnergyWh = Field(
        alias="productionWh"
    )

    consumption_wh: EnergyWh = Field(
        alias="consumptionWh"
    )

    net_energy_wh: StrictInt = Field(
        alias="netEnergyWh"
    )

    # Market information
    market_role: MarketRole = Field(
        alias="marketRole"
    )

    available_energy_wh: EnergyWh = Field(
        alias="availableEnergyWh"
    )

    required_energy_wh: EnergyWh = Field(
        alias="requiredEnergyWh"
    )

    # Energy source
    energy_type: EnergyType | None = Field(
        alias="energyType"
    )

    # Seller and buyer prices
    ask_price_microusd_per_kwh: PositivePrice | None = Field(
        alias="askPriceMicrousdPerKwh"
    )

    max_price_microusd_per_kwh: PositivePrice | None = Field(
        alias="maxPriceMicrousdPerKwh"
    )

    # User profile information
    x_km: float = Field(alias="xKm")
    y_km: float = Field(alias="yKm")

    reputation: Reputation

    preferred_energy_type: PreferredEnergyType = Field(
        alias="preferredEnergyType"
    )

    evm_address: str = Field(
        alias="evmAddress",
        pattern=r"^0x[a-fA-F0-9]{40}$"
    )

    # --------------------------------------------------
    # 5. Validate energy calculations and roles
    # --------------------------------------------------

    @model_validator(mode="after")
    def check_role_and_energy(self) -> HourlyEnergyRecord:

        net = (
            self.production_wh
            - self.consumption_wh
        )

        # Check net energy.
        if self.net_energy_wh != net:
            raise ValueError(
                "netEnergyWh must equal "
                "productionWh - consumptionWh"
            )

        # Determine the correct role.
        if net > 0:
            expected_role = MarketRole.SELLER
        elif net < 0:
            expected_role = MarketRole.BUYER
        else:
            expected_role = MarketRole.NEUTRAL

        if self.market_role != expected_role:
            raise ValueError(
                "marketRole does not match netEnergyWh"
            )

        # Verify available energy.
        if self.available_energy_wh != max(net, 0):
            raise ValueError(
                "availableEnergyWh does not match netEnergyWh"
            )

        # Verify required energy.
        if self.required_energy_wh != max(-net, 0):
            raise ValueError(
                "requiredEnergyWh does not match netEnergyWh"
            )

        # --------------------------------------------------
        # 6. SELLER rules
        # --------------------------------------------------

        if self.market_role == MarketRole.SELLER:

            if (
                self.energy_type is None
                or self.ask_price_microusd_per_kwh is None
            ):
                raise ValueError(
                    "SELLER requires energyType and "
                    "askPriceMicrousdPerKwh"
                )

            if self.max_price_microusd_per_kwh is not None:
                raise ValueError(
                    "SELLER must have a null "
                    "maxPriceMicrousdPerKwh"
                )

        # --------------------------------------------------
        # 7. BUYER rules
        # --------------------------------------------------

        elif self.market_role == MarketRole.BUYER:

            if (
                self.energy_type is not None
                or self.ask_price_microusd_per_kwh is not None
            ):
                raise ValueError(
                    "BUYER must have null energyType "
                    "and askPriceMicrousdPerKwh"
                )

            if self.max_price_microusd_per_kwh is None:
                raise ValueError(
                    "BUYER requires maxPriceMicrousdPerKwh"
                )

        # --------------------------------------------------
        # 8. NEUTRAL rules
        # --------------------------------------------------

        else:

            if any(
                value is not None
                for value in (
                    self.energy_type,
                    self.ask_price_microusd_per_kwh,
                    self.max_price_microusd_per_kwh,
                )
            ):
                raise ValueError(
                    "NEUTRAL must have null energyType "
                    "and prices"
                )

        return self


# --------------------------------------------------
# 9. EnergySnapshot model
# --------------------------------------------------

class EnergySnapshot(BaseModel):

    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        allow_inf_nan=False,
    )

    schema_version: str = Field(
        alias="schemaVersion",
        pattern=r"^[0-9]+\.[0-9]+\.[0-9]+$"
    )

    snapshot_id: UUID = Field(
        alias="snapshotId"
    )

    time_slot: HourTimeSlot = Field(
        alias="timeSlot"
    )

    generator_version: str = Field(
        alias="generatorVersion",
        pattern=r"^[0-9]+\.[0-9]+\.[0-9]+$"
    )

    users: list[HourlyEnergyRecord] = Field(
        min_length=1
    )

    # --------------------------------------------------
    # 10. Validate snapshot consistency
    # --------------------------------------------------

    @model_validator(mode="after")
    def check_snapshot_consistency(self) -> EnergySnapshot:

        user_ids = set()
        record_ids = set()

        for record in self.users:

            # All records must belong to the same hour.
            if record.time_slot != self.time_slot:
                raise ValueError(
                    "All records must match "
                    "the snapshot timeSlot"
                )

            # Check for duplicate users.
            if record.user_id in user_ids:
                raise ValueError(
                    "Duplicate userId in snapshot"
                )

            # Check for duplicate records.
            if record.record_id in record_ids:
                raise ValueError(
                    "Duplicate recordId in snapshot"
                )

            user_ids.add(record.user_id)
            record_ids.add(record.record_id)

        return self
