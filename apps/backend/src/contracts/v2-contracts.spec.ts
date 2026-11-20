import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateV2, type V2Contracts, type V2Kind } from '../../scripts/b21-v2-validator.mjs';

describe('B21 V2 TypeScript contracts', () => {
  it('types and validates each shared positive example', () => {
    const cases = JSON.parse(readFileSync(new URL('../../../../packages/shared/fixtures/v2-validation-vectors.json', import.meta.url), 'utf8')) as Array<{name: string; kind: V2Kind; value: unknown}>;
    const kinds: V2Kind[] = ['market', 'snapshot', 'position', 'allocation', 'intent', 'attempt', 'evidence', 'snapshotPayload', 'matchingManifest', 'snapshotMeasurement', 'allocationPlan'];
    const validated = Object.fromEntries(kinds.map((kind) => {
      const item = cases.find((entry) => entry.name === `valid ${kind}`);
      if (!item) throw new Error(`Missing ${kind} fixture`);
      return [kind, validateV2(kind, item.value)];
    })) as unknown as V2Contracts;
    expect(validated.market.schemaVersion).toBe('2.0.0');
    expect(validated.position.requiredWh).toBe('900');
    expect(validated.intent.chainId).toBe(296);
  });
});
