import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { B26MarketRunsController } from './b26-market-runs.controller.js';
import type { B26MarketRunsService } from './b26-market-runs.service.js';

describe('B26 read-only market-run query validation', () => {
  const list = vi
    .fn()
    .mockResolvedValue({ runs: [], simulationOnly: true, financialSummaryVerified: false });
  const controller = new B26MarketRunsController({ list } as unknown as B26MarketRunsService);
  it('accepts a bounded UTC interval and bounded page', async () => {
    await expect(
      controller.list('2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z', '10'),
    ).resolves.toMatchObject({ financialSummaryVerified: false });
    expect(list).toHaveBeenCalledWith(
      new Date('2026-10-01T00:00:00Z'),
      new Date('2026-10-02T00:00:00Z'),
      10,
      0,
    );
  });
  it('accepts a bounded offset and rejects invalid offsets', async () => {
    await controller.list('2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z', '10', '20');
    expect(list).toHaveBeenLastCalledWith(
      new Date('2026-10-01T00:00:00Z'),
      new Date('2026-10-02T00:00:00Z'),
      10,
      20,
    );
    for (const offset of ['-1', '01', '10001', 'abc'])
      expect(() =>
        controller.list('2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z', '10', offset),
      ).toThrow(BadRequestException);
  });
  it('rejects invalid dates, ranges, page size and timezone', () => {
    for (const [from, to, limit] of [
      ['2026-02-30T00:00:00Z', '2026-03-02T00:00:00Z', '2'],
      ['2026-10-01T00:00:00Z', '2026-12-01T00:00:00Z', '2'],
      ['2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z', '101'],
      ['2026-10-01T00:00:00-04:00', '2026-10-02T00:00:00Z', '2'],
    ])
      expect(() => controller.list(from, to, limit)).toThrow(BadRequestException);
  });
});
