
"""
Shared data models for the P2P Energy Trading Platform.
"""

from .models import (
    PreferredEnergyType,
    User,
    UserRegistry,
)

from .energy_models import (
    EnergyType,
    MarketRole,
    HourlyEnergyRecord,
    EnergySnapshot,
)

from .matching_models import (
    ScoringWeights,
    MatchingConfig,
    MatchingInput,
    MatchResult,
    MatchingOutput,
)

from .delivery_models import (
    DeliveryStatus,
    DeliveryRecord,
)

__version__ = "1.0.0"

__all__ = [
    "PreferredEnergyType",
    "User",
    "UserRegistry",
    "EnergyType",
    "MarketRole",
    "HourlyEnergyRecord",
    "EnergySnapshot",
    "ScoringWeights",
    "MatchingConfig",
    "MatchingInput",
    "MatchResult",
    "MatchingOutput",
    "DeliveryStatus",
    "DeliveryRecord",
]
