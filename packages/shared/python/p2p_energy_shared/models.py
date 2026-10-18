
from __future__ import annotations

from enum import Enum
from typing import Any
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    EmailStr,
    Field,
    StrictInt,
    model_validator,
)


# --------------------------------------------------
# 1. Define supported energy preferences
# --------------------------------------------------

class PreferredEnergyType(str, Enum):
    SOLAR = "SOLAR"
    WIND = "WIND"
    HYDRO = "HYDRO"
    GRID = "GRID"
    MIXED = "MIXED"
    ANY = "ANY"


# --------------------------------------------------
# 2. User model
# --------------------------------------------------

class User(BaseModel):

    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        allow_inf_nan=False,
    )

    # Unique user identifier
    user_id: UUID = Field(
        alias="userId"
    )

    # User information
    name: str = Field(
        min_length=1
    )

    email: EmailStr

    physical_address: str = Field(
        alias="physicalAddress",
        min_length=1
    )

    # Simulated geographical coordinates
    x_km: float = Field(
        alias="xKm"
    )

    y_km: float = Field(
        alias="yKm"
    )

    # Energy preferences
    preferred_energy_type: PreferredEnergyType = Field(
        alias="preferredEnergyType"
    )

    # Reputation between 0 and 100
    reputation: StrictInt = Field(
        ge=0,
        le=100
    )

    # Optional blockchain account information
    hedera_account_id: str | None = Field(
        default=None,
        alias="hederaAccountId",
        pattern=r"^0\.0\.[0-9]+$"
    )

    evm_address: str | None = Field(
        default=None,
        alias="evmAddress",
        pattern=r"^0x[a-fA-F0-9]{40}$"
    )

    # --------------------------------------------------
    # 3. Prevent explicit null wallet fields
    # --------------------------------------------------

    @model_validator(mode="before")
    @classmethod
    def prevent_explicit_null_wallets(
        cls,
        value: Any
    ) -> Any:

        if isinstance(value, dict):

            wallet_fields = (
                "hederaAccountId",
                "evmAddress",
                "hedera_account_id",
                "evm_address",
            )

            for field_name in wallet_fields:

                if (
                    field_name in value
                    and value[field_name] is None
                ):
                    raise ValueError(
                        f"{field_name} cannot be null; "
                        "omit the field instead"
                    )

        return value

    # --------------------------------------------------
    # 4. Validate blockchain account information
    # --------------------------------------------------

    @model_validator(mode="after")
    def check_wallet_pair(self) -> User:

        has_hedera_account = (
            self.hedera_account_id is not None
        )

        has_evm_address = (
            self.evm_address is not None
        )

        if has_hedera_account != has_evm_address:
            raise ValueError(
                "hederaAccountId and evmAddress "
                "must be provided together"
            )

        return self


# --------------------------------------------------
# 5. UserRegistry model
# --------------------------------------------------

class UserRegistry(BaseModel):

    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
    )

    schema_version: str = Field(
        alias="schemaVersion",
        pattern=r"^[0-9]+\.[0-9]+\.[0-9]+$"
    )

    users: list[User] = Field(
        min_length=1
    )

    # --------------------------------------------------
    # 6. Prevent duplicate users
    # --------------------------------------------------

    @model_validator(mode="after")
    def check_unique_users(self) -> UserRegistry:

        # Check duplicate user IDs
        user_ids = [
            user.user_id
            for user in self.users
        ]

        if len(user_ids) != len(set(user_ids)):
            raise ValueError(
                "duplicate userId in registry"
            )

        # Check duplicate email addresses
        emails = [
            str(user.email).casefold()
            for user in self.users
        ]

        if len(emails) != len(set(emails)):
            raise ValueError(
                "duplicate email in registry"
            )

        return self
