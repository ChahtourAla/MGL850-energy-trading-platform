"""Pydantic wrappers for the versioned JSON contracts.

These validate local semantics only; identity references require persisted
context and a VERIFIED flag does not itself prove blockchain finality.
"""
from typing import Any, ClassVar
from pydantic import RootModel, model_validator
from .v2_validation import validate_v2

class _V2Record(RootModel[dict[str, Any]]):
    kind: ClassVar[str]

    @model_validator(mode='after')
    def validate_contract(self):
        validate_v2(self.kind, self.root)
        return self

class V2Market(_V2Record):
    kind = 'market'

class V2Snapshot(_V2Record):
    kind = 'snapshot'

class V2Position(_V2Record):
    kind = 'position'

class V2Allocation(_V2Record):
    kind = 'allocation'

class V2SettlementIntent(_V2Record):
    kind = 'intent'

class V2SettlementAttempt(_V2Record):
    kind = 'attempt'

class V2SettlementEvidence(_V2Record):
    kind = 'evidence'

class V2SnapshotPayload(_V2Record):
    kind = 'snapshotPayload'

class V2MatchingManifest(_V2Record):
    kind = 'matchingManifest'

class V2SnapshotMeasurement(_V2Record):
    kind = 'snapshotMeasurement'

class V2AllocationPlan(_V2Record):
    kind = 'allocationPlan'
