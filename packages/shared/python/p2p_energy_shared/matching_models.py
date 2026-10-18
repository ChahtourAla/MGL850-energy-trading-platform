
"""
Shared Pydantic models for matching inputs and outputs.
"""

from __future__ import annotations

import math
from datetime import datetime
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

from .energy_models import (
    EnergySnapshot,
    EnergyType,
    HourTimeSlot,
    HourlyEnergyRecord,
)


# --------------------------------------------------
# 1. Reusable validation types
# --------------------------------------------------

Version = Annotated[
    str,
    Field(pattern=r"^[0-9]+\.[0-9]+\.[0-9]+$"),
]

EvmAddress = Annotated[
    str,
    Field(pattern=r"^0x[a-fA-F0-9]{40}$"),
]


def check_utc_timestamp(value: str) -> str:
    """
    Require a valid ISO 8601 timestamp ending in Z.
    """

    try:
        datetime.fromisoformat(
            value.replace("Z", "+00:00")
        )
    except ValueError as error:
        raise ValueError(
            "createdAt must be a valid UTC timestamp"
        ) from error

    return value


UTCTimestamp = Annotated[
    str,
    Field(strict=True, pattern=r"Z$"),
    AfterValidator(check_utc_timestamp),
]


# --------------------------------------------------
# 2. ScoringWeights model
# --------------------------------------------------

class ScoringWeights(BaseModel):

    model_config = ConfigDict(
        extra="forbid",
        allow_inf_nan=False,
    )

    quantity: float = Field(ge=0, le=1)
    price: float = Field(ge=0, le=1)
    distance: float = Field(ge=0, le=1)
    reputation: float = Field(ge=0, le=1)

    @model_validator(mode="after")
    def validate_total(self) -> ScoringWeights:

        total = (
            self.quantity
            + self.price
            + self.distance
            + self.reputation
        )

        if not math.isclose(
            total,
            1.0,
            rel_tol=0,
            abs_tol=1e-9
        ):
            raise ValueError(
                "scoringWeights must add up to 1.0"
            )

        return self


# --------------------------------------------------
# 3. MatchingConfig model
# --------------------------------------------------

class MatchingConfig(BaseModel):

    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        allow_inf_nan=False,
    )

    schema_version: Version = Field(
        alias="schemaVersion"
    )

    algorithm_version: Version = Field(
        alias="algorithmVersion"
    )

    maximum_distance_km: float = Field(
        alias="maximumDistanceKm",
        gt=0
    )

    scoring_weights: ScoringWeights = Field(
        alias="scoringWeights"
    )


# --------------------------------------------------
# 4. MatchingInput model
# --------------------------------------------------

class MatchingInput(BaseModel):

    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        allow_inf_nan=False,
    )

    schema_version: Version = Field(
        alias="schemaVersion"
    )

    snapshot_id: UUID = Field(
        alias="snapshotId"
    )

    time_slot: HourTimeSlot = Field(
        alias="timeSlot"
    )

    algorithm_version: Version = Field(
        alias="algorithmVersion"
    )

    maximum_distance_km: float = Field(
        alias="maximumDistanceKm",
        gt=0
    )

    scoring_weights: ScoringWeights = Field(
        alias="scoringWeights"
    )

    users: list[HourlyEnergyRecord] = Field(
        min_length=1
    )

    # --------------------------------------------------
    # 5. Validate matching input consistency
    # --------------------------------------------------

    @model_validator(mode="after")
    def check_records(self) -> MatchingInput:

        user_ids = set()
        record_ids = set()

        for record in self.users:

            if record.time_slot != self.time_slot:
                raise ValueError(
                    "MatchingInput user timeSlot differs "
                    "from input timeSlot"
                )

            if record.user_id in user_ids:
                raise ValueError(
                    "Duplicate userId in MatchingInput"
                )

            if record.record_id in record_ids:
                raise ValueError(
                    "Duplicate recordId in MatchingInput"
                )

            user_ids.add(record.user_id)
            record_ids.add(record.record_id)

        return self

    # --------------------------------------------------
    # 6. Build input from a snapshot and configuration
    # --------------------------------------------------

    @classmethod
    def from_snapshot(
        cls,
        snapshot: EnergySnapshot,
        config: MatchingConfig,
    ) -> MatchingInput:

        if snapshot.schema_version != config.schema_version:
            raise ValueError(
                "Snapshot and configuration "
                "schema versions differ"
            )

        return cls(
            schemaVersion=snapshot.schema_version,
            snapshotId=snapshot.snapshot_id,
            timeSlot=snapshot.time_slot,
            algorithmVersion=config.algorithm_version,
            maximumDistanceKm=config.maximum_distance_km,
            scoringWeights=config.scoring_weights,
            users=snapshot.users,
        )


# --------------------------------------------------
# 7. MatchResult model
# --------------------------------------------------

class MatchResult(BaseModel):

    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        allow_inf_nan=False,
    )

    match_id: UUID = Field(
        alias="matchId"
    )

    algorithm_version: Version = Field(
        alias="algorithmVersion"
    )

    time_slot: HourTimeSlot = Field(
        alias="timeSlot"
    )

    buyer_id: UUID = Field(
        alias="buyerId"
    )

    buyer_wallet: EvmAddress = Field(
        alias="buyerWallet"
    )

    seller_id: UUID = Field(
        alias="sellerId"
    )

    seller_wallet: EvmAddress = Field(
        alias="sellerWallet"
    )

    quantity_wh: StrictInt = Field(
        alias="quantityWh",
        gt=0
    )

    unit_price_microusd_per_kwh: StrictInt = Field(
        alias="unitPriceMicrousdPerKwh",
        gt=0
    )

    total_amount_microusd: StrictInt = Field(
        alias="totalAmountMicrousd",
        gt=0
    )

    distance_km: float = Field(
        alias="distanceKm",
        ge=0
    )

    score: float = Field(
        ge=0,
        le=1
    )

    seller_energy_type: EnergyType = Field(
        alias="sellerEnergyType"
    )

    created_at: UTCTimestamp = Field(
        alias="createdAt"
    )

    # --------------------------------------------------
    # 8. Validate participants and payment
    # --------------------------------------------------

    @model_validator(mode="after")
    def check_payment_and_participants(self) -> MatchResult:

        if self.buyer_id == self.seller_id:
            raise ValueError(
                "Buyer and seller must be different users"
            )

        expected_total = (
            self.quantity_wh
            * self.unit_price_microusd_per_kwh
            // 1000
        )

        if self.total_amount_microusd != expected_total:
            raise ValueError(
                "totalAmountMicrousd does not match "
                "quantity and price"
            )

        return self


# --------------------------------------------------
# 9. MatchingOutput model
# --------------------------------------------------

class MatchingOutput(BaseModel):

    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        allow_inf_nan=False,
    )

    schema_version: Version = Field(
        alias="schemaVersion"
    )

    snapshot_id: UUID = Field(
        alias="snapshotId"
    )

    time_slot: HourTimeSlot = Field(
        alias="timeSlot"
    )

    algorithm_version: Version = Field(
        alias="algorithmVersion"
    )

    execution_time_ms: float = Field(
        alias="executionTimeMs",
        ge=0
    )

    matches: list[MatchResult]

    unmatched_buyer_ids: list[UUID] = Field(
        alias="unmatchedBuyerIds"
    )

    warnings: list[str]

    # --------------------------------------------------
    # 10. Validate matching output consistency
    # --------------------------------------------------

    @model_validator(mode="after")
    def check_result_consistency(self) -> MatchingOutput:

        match_ids = set()
        matched_buyers = set()

        for match in self.matches:

            if match.time_slot != self.time_slot:
                raise ValueError(
                    "Match timeSlot differs "
                    "from output timeSlot"
                )

            if match.algorithm_version != self.algorithm_version:
                raise ValueError(
                    "Match algorithmVersion "
                    "differs from output"
                )

            if match.match_id in match_ids:
                raise ValueError(
                    "Duplicate matchId"
                )

            if match.buyer_id in matched_buyers:
                raise ValueError(
                    "Buyer matched more than once"
                )

            match_ids.add(match.match_id)
            matched_buyers.add(match.buyer_id)

        unmatched = set(
            self.unmatched_buyer_ids
        )

        if len(unmatched) != len(self.unmatched_buyer_ids):
            raise ValueError(
                "Duplicate unmatchedBuyerIds"
            )

        if matched_buyers & unmatched:
            raise ValueError(
                "Buyer is both matched and unmatched"
            )

        return self
