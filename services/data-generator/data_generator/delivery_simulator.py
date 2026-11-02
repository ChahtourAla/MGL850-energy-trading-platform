
"""
Deterministic, off-chain simulation of energy delivery evidence.

This module does not create trades, confirm delivery,
or call Hedera.

A missing delivery is represented by the ABSENCE
of a DeliveryRecord.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from enum import Enum
from typing import Literal
from uuid import UUID, uuid5

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictInt,
    field_validator,
    model_validator,
)

from p2p_energy_shared import (
    DeliveryRecord,
    DeliveryStatus,
)


# --------------------------------------------------
# 1. Supported simulation scenarios
# --------------------------------------------------

class DeliveryScenario(str, Enum):

    SUCCESS = "SUCCESS"
    INCOMPLETE = "INCOMPLETE"
    MISSING = "MISSING"
    INVALID = "INVALID"


# --------------------------------------------------
# 2. UTC timestamp helpers
# --------------------------------------------------

def _parse_utc(value: str) -> datetime:

    if (
        not isinstance(value, str)
        or not value.endswith("Z")
    ):
        raise ValueError(
            "Timestamp must be an ISO 8601 "
            "UTC string ending in Z"
        )

    try:
        parsed = datetime.fromisoformat(
            value.replace("Z", "+00:00")
        )

    except ValueError as error:
        raise ValueError(
            "Invalid ISO 8601 UTC timestamp"
        ) from error

    if parsed.utcoffset() != timedelta(0):
        raise ValueError(
            "Timestamp must be UTC"
        )

    return parsed


def _to_utc_string(value: datetime) -> str:

    return value.isoformat().replace(
        "+00:00",
        "Z",
    )


# --------------------------------------------------
# 3. Input model for an active energy trade
# --------------------------------------------------

class ActiveTrade(BaseModel):
    """
    Minimal active-trade data supplied by a future
    backend or by a test fixture.

    This is an internal simulator input model,
    not a new shared JSON contract.
    """

    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
    )

    trade_id: UUID = Field(
        alias="tradeId"
    )

    on_chain_trade_id: StrictInt = Field(
        alias="onChainTradeId",
        ge=1,
    )

    seller_id: UUID = Field(
        alias="sellerId"
    )

    buyer_id: UUID = Field(
        alias="buyerId"
    )

    expected_wh: StrictInt = Field(
        alias="expectedWh",
        ge=1,
    )

    delivery_start: str = Field(
        alias="deliveryStart",
        strict=True,
    )

    delivery_deadline: str = Field(
        alias="deliveryDeadline",
        strict=True,
    )

    status: Literal[
        "AWAITING_DELIVERY"
    ]

    # ----------------------------------------------
    # Validate timestamps
    # ----------------------------------------------

    @field_validator(
        "delivery_start",
        "delivery_deadline",
    )
    @classmethod
    def validate_utc_time(
        cls,
        value: str,
    ) -> str:

        _parse_utc(value)

        return value

    # ----------------------------------------------
    # Validate active-trade rules
    # ----------------------------------------------

    @model_validator(mode="after")
    def validate_trade(self) -> ActiveTrade:

        if self.seller_id == self.buyer_id:
            raise ValueError(
                "Buyer and seller must be "
                "different users"
            )

        if (
            _parse_utc(self.delivery_start)
            >= _parse_utc(self.delivery_deadline)
        ):
            raise ValueError(
                "deliveryDeadline must be later "
                "than deliveryStart"
            )

        return self


# --------------------------------------------------
# 4. Main delivery simulation function
# --------------------------------------------------

def simulate_delivery(
    trade: ActiveTrade,
    scenario: DeliveryScenario,
    *,
    delivered_wh: int | None = None,
    reported_at: str | None = None,
) -> DeliveryRecord | None:
    """
    Simulate one delivery outcome for one active trade.

    SUCCESS:
        Delivered quantity meets expected quantity.
        The timestamp is inside the delivery window.

    INCOMPLETE:
        Delivered quantity is below expected quantity.
        The timestamp is inside the delivery window.

    MISSING:
        No delivery record is emitted.
        Returns None.

    INVALID:
        Produces schema-valid evidence timestamped
        outside the allowed delivery window.
        A future oracle must reject that evidence.

    No blockchain transaction is performed.
    """

    # ----------------------------------------------
    # A. Validate function arguments
    # ----------------------------------------------

    if not isinstance(trade, ActiveTrade):
        raise TypeError(
            "trade must be an ActiveTrade"
        )

    if not isinstance(
        scenario,
        DeliveryScenario,
    ):
        raise TypeError(
            "scenario must be a DeliveryScenario"
        )

    if (
        delivered_wh is not None
        and type(delivered_wh) is not int
    ):
        raise TypeError(
            "delivered_wh must be an integer"
        )

    if (
        delivered_wh is not None
        and delivered_wh < 0
    ):
        raise ValueError(
            "delivered_wh cannot be negative"
        )

    # ----------------------------------------------
    # B. Parse optional reported timestamp
    # ----------------------------------------------

    if reported_at is not None:
        report_time = _parse_utc(
            reported_at
        )
    else:
        report_time = None

    # ----------------------------------------------
    # C. Missing delivery
    # ----------------------------------------------

    if scenario is DeliveryScenario.MISSING:

        if (
            delivered_wh is not None
            or reported_at is not None
        ):
            raise ValueError(
                "MISSING cannot contain "
                "delivery measurements"
            )

        return None

    # ----------------------------------------------
    # D. Read delivery window
    # ----------------------------------------------

    start = _parse_utc(
        trade.delivery_start
    )

    deadline = _parse_utc(
        trade.delivery_deadline
    )

    # ----------------------------------------------
    # E. Invalid delivery evidence
    # ----------------------------------------------

    if scenario is DeliveryScenario.INVALID:

        # By default, report one second too late.
        # The future oracle should reject this.
        timestamp = (
            report_time
            or deadline + timedelta(seconds=1)
        )

        if start <= timestamp <= deadline:
            raise ValueError(
                "INVALID scenario requires "
                "a timestamp outside "
                "the delivery window"
            )

        actual_wh = (
            trade.expected_wh
            if delivered_wh is None
            else delivered_wh
        )

        status = DeliveryStatus.INVALID

    # ----------------------------------------------
    # F. Successful or incomplete delivery
    # ----------------------------------------------

    else:

        timestamp = report_time or start

        if not start <= timestamp <= deadline:
            raise ValueError(
                "Delivery timestamp must be "
                "inside the delivery window"
            )

        # ------------------------------------------
        # SUCCESS scenario
        # ------------------------------------------

        if scenario is DeliveryScenario.SUCCESS:

            actual_wh = (
                trade.expected_wh
                if delivered_wh is None
                else delivered_wh
            )

            if actual_wh < trade.expected_wh:
                raise ValueError(
                    "SUCCESS requires "
                    "deliveredWh >= expectedWh"
                )

            status = DeliveryStatus.SUCCESS

        # ------------------------------------------
        # INCOMPLETE scenario
        # ------------------------------------------

        else:

            actual_wh = (
                trade.expected_wh // 2
                if delivered_wh is None
                else delivered_wh
            )

            if actual_wh >= trade.expected_wh:
                raise ValueError(
                    "INCOMPLETE requires "
                    "deliveredWh < expectedWh"
                )

            status = DeliveryStatus.INCOMPLETE

    # ----------------------------------------------
    # G. Create deterministic delivery identifier
    # ----------------------------------------------

    time_slot = _to_utc_string(
        timestamp
    )

    delivery_id = uuid5(
        trade.trade_id,
        (
            f"delivery:{trade.on_chain_trade_id}:"
            f"{scenario.value}:"
            f"{time_slot}:{actual_wh}"
        ),
    )

    # ----------------------------------------------
    # H. Build shared DeliveryRecord
    # ----------------------------------------------

    return DeliveryRecord(
        deliveryId=delivery_id,
        tradeId=trade.trade_id,
        onChainTradeId=trade.on_chain_trade_id,
        sellerId=trade.seller_id,
        buyerId=trade.buyer_id,
        expectedWh=trade.expected_wh,
        deliveredWh=actual_wh,
        timeSlot=time_slot,
        status=status,
    )
