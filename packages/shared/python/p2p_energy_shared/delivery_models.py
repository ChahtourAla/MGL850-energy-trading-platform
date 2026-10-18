
"""
Shared Pydantic model for electricity delivery records.
"""

from __future__ import annotations

from enum import Enum
from typing import Any
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictInt,
    model_validator,
)

from .matching_models import UTCTimestamp


# --------------------------------------------------
# 1. Delivery status values
# --------------------------------------------------

class DeliveryStatus(str, Enum):
    PENDING = "PENDING"
    SUCCESS = "SUCCESS"
    INCOMPLETE = "INCOMPLETE"
    INVALID = "INVALID"
    CONFIRMED = "CONFIRMED"


# --------------------------------------------------
# 2. DeliveryRecord model
# --------------------------------------------------

class DeliveryRecord(BaseModel):

    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        allow_inf_nan=False,
    )

    # Unique delivery identifier
    delivery_id: UUID = Field(
        alias="deliveryId"
    )

    # Trade identifier in the backend
    trade_id: UUID = Field(
        alias="tradeId"
    )

    # Numeric trade ID in the Hedera contract
    on_chain_trade_id: StrictInt = Field(
        alias="onChainTradeId",
        ge=1
    )

    # Participants
    seller_id: UUID = Field(
        alias="sellerId"
    )

    buyer_id: UUID = Field(
        alias="buyerId"
    )

    # Electricity quantities in Wh
    expected_wh: StrictInt = Field(
        alias="expectedWh",
        ge=1
    )

    delivered_wh: StrictInt = Field(
        alias="deliveredWh",
        ge=0
    )

    # UTC delivery timestamp
    time_slot: UTCTimestamp = Field(
        alias="timeSlot"
    )

    # Delivery processing status
    status: DeliveryStatus

    # Optional 32-byte evidence hash
    evidence_hash: str | None = Field(
        default=None,
        alias="evidenceHash",
        pattern=r"^0x[a-fA-F0-9]{64}$"
    )

    # --------------------------------------------------
    # 3. Reject an explicitly null evidence hash
    # --------------------------------------------------

    @model_validator(mode="before")
    @classmethod
    def validate_optional_evidence(
        cls,
        value: Any
    ) -> Any:

        if isinstance(value, dict):

            for name in ("evidenceHash", "evidence_hash"):

                if name in value and value[name] is None:
                    raise ValueError(
                        "Omit evidenceHash when unavailable; "
                        "do not provide null"
                    )

        return value

    # --------------------------------------------------
    # 4. Validate delivery business rules
    # --------------------------------------------------

    @model_validator(mode="after")
    def check_delivery_rules(self) -> DeliveryRecord:

        # A user cannot sell energy to themselves.
        if self.buyer_id == self.seller_id:
            raise ValueError(
                "Buyer and seller must be different users"
            )

        # Successful and confirmed deliveries
        # must meet the expected quantity.
        if self.status in (
            DeliveryStatus.SUCCESS,
            DeliveryStatus.CONFIRMED,
        ):

            if self.delivered_wh < self.expected_wh:
                raise ValueError(
                    "Successful or confirmed delivery "
                    "must meet expectedWh"
                )

        # Incomplete deliveries fall below the
        # expected energy quantity.
        elif self.status == DeliveryStatus.INCOMPLETE:

            if self.delivered_wh >= self.expected_wh:
                raise ValueError(
                    "Incomplete delivery must be "
                    "below expectedWh"
                )

        # Pending means that no energy has
        # been reported yet.
        elif self.status == DeliveryStatus.PENDING:

            if self.delivered_wh != 0:
                raise ValueError(
                    "Pending delivery must have "
                    "deliveredWh = 0"
                )

        # INVALID records are permitted without
        # asserting successful delivery.
        # Their evidence will be reviewed later.

        return self
