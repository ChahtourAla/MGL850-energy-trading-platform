
"""
Configuration models and loader for hourly energy simulation.

This module validates settings only.
It does not generate hourly energy records yet.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Annotated

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictInt,
    ValidationError,
    model_validator,
)


# --------------------------------------------------
# 1. Reusable profile values
# --------------------------------------------------

SolarFactor = Annotated[
    float,
    Field(ge=0, le=1, allow_inf_nan=False),
]

ConsumptionFactor = Annotated[
    float,
    Field(ge=0, le=2, allow_inf_nan=False),
]


# --------------------------------------------------
# 2. Price range model
# --------------------------------------------------

class PriceRange(BaseModel):

    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
    )

    minimum: StrictInt = Field(
        alias="minMicrousdPerKwh",
        gt=0,
    )

    maximum: StrictInt = Field(
        alias="maxMicrousdPerKwh",
        gt=0,
    )

    @model_validator(mode="after")
    def validate_price_order(self) -> PriceRange:

        if self.minimum > self.maximum:
            raise ValueError(
                "Minimum price cannot exceed maximum price"
            )

        return self


# --------------------------------------------------
# 3. Production energy type distribution
# --------------------------------------------------

class ProductionEnergyTypeWeights(BaseModel):

    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        allow_inf_nan=False,
    )

    solar: float = Field(alias="SOLAR", ge=0, le=1)
    wind: float = Field(alias="WIND", ge=0, le=1)
    hydro: float = Field(alias="HYDRO", ge=0, le=1)
    grid: float = Field(alias="GRID", ge=0, le=1)
    mixed: float = Field(alias="MIXED", ge=0, le=1)

    @model_validator(mode="after")
    def validate_weight_total(
        self,
    ) -> ProductionEnergyTypeWeights:

        total = (
            self.solar
            + self.wind
            + self.hydro
            + self.grid
            + self.mixed
        )

        if not math.isclose(
            total,
            1.0,
            rel_tol=0,
            abs_tol=1e-9,
        ):
            raise ValueError(
                "Production energy type weights "
                "must add up to 1.0"
            )

        return self


# --------------------------------------------------
# 4. Complete hourly energy configuration
# --------------------------------------------------

class EnergyGenerationConfig(BaseModel):

    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        allow_inf_nan=False,
    )

    # Versions and deterministic random seed
    schema_version: str = Field(
        alias="schemaVersion",
        pattern=r"^[0-9]+\.[0-9]+\.[0-9]+$",
    )

    generator_version: str = Field(
        alias="generatorVersion",
        pattern=r"^[0-9]+\.[0-9]+\.[0-9]+$",
    )

    seed: StrictInt = Field(ge=0)

    # Base hourly energy quantities
    base_consumption_wh: StrictInt = Field(
        alias="baseConsumptionWh",
        gt=0,
    )

    peak_solar_production_wh: StrictInt = Field(
        alias="peakSolarProductionWh",
        gt=0,
    )

    base_non_solar_production_wh: StrictInt = Field(
        alias="baseNonSolarProductionWh",
        ge=0,
    )

    # Maximum relative random variation
    production_variation_fraction: float = Field(
        alias="productionVariationFraction",
        ge=0,
        le=0.5,
    )

    consumption_variation_fraction: float = Field(
        alias="consumptionVariationFraction",
        ge=0,
        le=0.5,
    )

    # Exactly 24 values: hours 0 through 23
    solar_production_profile: list[SolarFactor] = Field(
        alias="solarProductionProfile",
        min_length=24,
        max_length=24,
    )

    consumption_profile: list[ConsumptionFactor] = Field(
        alias="consumptionProfile",
        min_length=24,
        max_length=24,
    )

    # Production technology distribution
    production_energy_type_weights: (
        ProductionEnergyTypeWeights
    ) = Field(
        alias="productionEnergyTypeWeights"
    )

    # Prices in integer micro-USD/kWh
    seller_ask_price_range: PriceRange = Field(
        alias="sellerAskPriceRange"
    )

    buyer_max_price_range: PriceRange = Field(
        alias="buyerMaxPriceRange"
    )

    # --------------------------------------------------
    # 5. Check that trading prices can overlap
    # --------------------------------------------------

    @model_validator(mode="after")
    def check_price_overlap(
        self,
    ) -> EnergyGenerationConfig:

        seller_minimum = (
            self.seller_ask_price_range.minimum
        )

        buyer_maximum = (
            self.buyer_max_price_range.maximum
        )

        if seller_minimum > buyer_maximum:
            raise ValueError(
                "Seller and buyer price ranges "
                "do not overlap"
            )

        return self


# --------------------------------------------------
# 6. Read and validate configuration JSON
# --------------------------------------------------

def load_energy_config(
    file_path: str | Path,
) -> EnergyGenerationConfig:

    path = Path(file_path)

    if not path.is_file():
        raise FileNotFoundError(
            f"Energy configuration not found: {path}"
        )

    try:
        content = path.read_text(encoding="utf-8")

    except UnicodeDecodeError as error:
        raise ValueError(
            f"Energy configuration must be UTF-8: {path}"
        ) from error

    try:
        return EnergyGenerationConfig.model_validate_json(
            content
        )

    except ValidationError as error:
        raise ValueError(
            f"Invalid energy configuration '{path}': "
            f"{error}"
        ) from error
