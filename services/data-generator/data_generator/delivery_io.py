
"""JSON input, configuration, and output helpers for delivery simulation."""

from __future__ import annotations

import json
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, StrictInt

from p2p_energy_shared import DeliveryRecord
from data_generator.delivery_simulator import ActiveTrade, DeliveryScenario


class DeliverySimulationConfig(BaseModel):
    """Configuration for exactly one simulated active-trade delivery."""

    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
    )

    scenario: DeliveryScenario

    delivered_wh: StrictInt | None = Field(
        default=None,
        alias="deliveredWh",
        ge=0,
    )

    reported_at: str | None = Field(
        default=None,
        alias="reportedAt",
        strict=True,
    )


def _load_object(path: str | Path) -> dict:
    """Read a JSON object; reject arrays and scalar values."""

    raw = json.loads(
        Path(path).read_text(encoding="utf-8")
    )

    if not isinstance(raw, dict):
        raise ValueError("Expected a JSON object")

    return raw


def load_active_trade(path: str | Path) -> ActiveTrade:
    return ActiveTrade.model_validate(
        _load_object(path)
    )


def load_delivery_config(
    path: str | Path,
) -> DeliverySimulationConfig:

    return DeliverySimulationConfig.model_validate(
        _load_object(path)
    )


def save_delivery_record(
    record: DeliveryRecord,
    output: str | Path,
    *,
    overwrite: bool = False,
) -> Path:
    """Export a shared-schema-compatible DeliveryRecord."""

    if not isinstance(record, DeliveryRecord):
        raise TypeError(
            "record must be a DeliveryRecord"
        )

    if type(overwrite) is not bool:
        raise TypeError(
            "overwrite must be a boolean"
        )

    path = Path(output)

    path.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    content = record.model_dump_json(
        by_alias=True,
        exclude_none=True,
        indent=2,
    )

    with path.open(
        "w" if overwrite else "x",
        encoding="utf-8",
        newline="\n",
    ) as handle:
        handle.write(content + "\n")

    return path
