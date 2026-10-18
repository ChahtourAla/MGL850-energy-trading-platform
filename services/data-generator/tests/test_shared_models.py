
from pathlib import Path

from p2p_energy_shared import (
    EnergySnapshot,
    UserRegistry,
)


ROOT = Path(__file__).resolve().parents[3]

FIXTURES = ROOT / "packages" / "shared" / "fixtures"


# --------------------------------------------------
# TEST 1 — Data Generator can read shared users
# --------------------------------------------------

def test_generator_can_load_user_registry():

    path = FIXTURES / "user-registry.sample.json"

    registry = UserRegistry.model_validate_json(
        path.read_text(encoding="utf-8")
    )

    assert len(registry.users) == 2
    assert registry.users[0].name == "Solar House"


# --------------------------------------------------
# TEST 2 — Data Generator can use EnergySnapshot
# --------------------------------------------------

def test_generator_can_load_energy_snapshot():

    path = FIXTURES / "energy-snapshot.sample.json"

    snapshot = EnergySnapshot.model_validate_json(
        path.read_text(encoding="utf-8")
    )

    assert len(snapshot.users) == 2

    seller = snapshot.users[0]

    assert seller.production_wh == 6000
    assert seller.consumption_wh == 2000
    assert seller.available_energy_wh == 4000
