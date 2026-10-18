
"""
Generate reproducible simulated user profiles.

This module creates static user information only.
It does not create blockchain wallets, generate
energy records, or assign market roles.
"""

import random
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictInt,
    ValidationError,
    model_validator,
)

from p2p_energy_shared import (
    PreferredEnergyType,
    User,
    UserRegistry,
)


# --------------------------------------------------
# 1. Define the generator configuration model
# --------------------------------------------------

class RegistryGenerationConfig(BaseModel):

    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        allow_inf_nan=False,
    )

    schema_version: str = Field(
        alias="schemaVersion",
        pattern=r"^[0-9]+\.[0-9]+\.[0-9]+$",
    )

    user_count: StrictInt = Field(
        alias="userCount",
        ge=1,
        le=10000,
    )

    seed: StrictInt = Field(
        ge=0,
    )

    map_width_km: float = Field(
        alias="mapWidthKm",
        gt=0,
    )

    map_height_km: float = Field(
        alias="mapHeightKm",
        gt=0,
    )

    minimum_reputation: StrictInt = Field(
        alias="minimumReputation",
        ge=0,
        le=100,
    )

    maximum_reputation: StrictInt = Field(
        alias="maximumReputation",
        ge=0,
        le=100,
    )

    energy_preferences: list[PreferredEnergyType] = Field(
        alias="energyPreferences",
        min_length=1,
    )

    @model_validator(mode="after")
    def validate_reputation_range(
        self,
    ) -> "RegistryGenerationConfig":

        if self.minimum_reputation > self.maximum_reputation:
            raise ValueError(
                "minimumReputation cannot exceed "
                "maximumReputation"
            )

        return self


# --------------------------------------------------
# 2. Load the generator configuration from JSON
# --------------------------------------------------

def load_generation_config(
    file_path: str | Path,
) -> RegistryGenerationConfig:

    path = Path(file_path)

    if not path.is_file():
        raise FileNotFoundError(
            f"Generation configuration not found: {path}"
        )

    content = path.read_text(
        encoding="utf-8"
    )

    try:
        config = RegistryGenerationConfig.model_validate_json(
            content
        )

    except ValidationError as error:
        raise ValueError(
            f"Invalid generation configuration '{path}': "
            f"{error}"
        ) from error

    return config


# --------------------------------------------------
# 3. Generate the static user registry
# --------------------------------------------------

def generate_user_registry(
    config: RegistryGenerationConfig,
) -> UserRegistry:

    # A local random generator guarantees that
    # repeated calls with the same seed start
    # with the same random sequence.
    rng = random.Random(config.seed)

    users = []

    for index in range(1, config.user_count + 1):

        # Generate a deterministic UUID.
        # The same seed and user index always
        # produce the same user ID.
        user_id = uuid5(
            NAMESPACE_URL,
            (
                "p2p-energy-trading:"
                f"user:{config.seed}:{index}"
            ),
        )

        # Generate a fictional location inside
        # the configured geographic area.
        x_km = round(
            rng.uniform(0, config.map_width_km),
            3,
        )

        y_km = round(
            rng.uniform(0, config.map_height_km),
            3,
        )

        # Randomly select an energy preference.
        energy_preference = rng.choice(
            config.energy_preferences
        )

        # Generate reputation within the range.
        reputation = rng.randint(
            config.minimum_reputation,
            config.maximum_reputation,
        )

        # Create a validated User object.
        user = User(
            userId=user_id,
            name=f"Household {index:04d}",
            email=(
                f"household-{config.seed}-{index:04d}"
                "@example.com"
            ),
            physicalAddress=(
                f"Simulated Address {index}, Test Grid"
            ),
            xKm=x_km,
            yKm=y_km,
            preferredEnergyType=energy_preference,
            reputation=reputation,
        )

        # No wallets are created here.
        users.append(user)

    # Use the shared model to validate
    # the complete user registry.
    return UserRegistry(
        schemaVersion=config.schema_version,
        users=users,
    )


# --------------------------------------------------
# 4. Save the generated registry as JSON
# --------------------------------------------------

def save_user_registry(
    registry: UserRegistry,
    file_path: str | Path,
    overwrite: bool = False,
) -> Path:

    path = Path(file_path)

    # Prevent accidental replacement of an
    # existing user registry.
    if path.exists() and not overwrite:
        raise FileExistsError(
            f"Registry already exists: {path}"
        )

    # Create the output folder if necessary.
    path.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    # Export Python objects using the exact
    # camelCase field names from our schemas.
    json_content = registry.model_dump_json(
        by_alias=True,
        exclude_none=True,
        indent=2,
    )

    path.write_text(
        json_content + "\n",
        encoding="utf-8",
    )

    return path
