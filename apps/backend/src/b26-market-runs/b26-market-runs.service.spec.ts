import { describe, it, expect } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { B26MarketRunsService } from './b26-market-runs.service.js';
describe('B26 reporting canonicality', () => {
  it('does not present a stored settled state as current verification', async () => {
    const service = new B26MarketRunsService({ get: () => undefined } as unknown as ConfigService);
    const client = {
      query: async (sql: string) =>
        sql.includes('session_user')
          ? { rows: [{ actor: 'b26_reporter', guarded: true }] }
          : {
              rows: [{ id: 'run', status: 'SETTLED', summary: { verifiedPaidBaseUnits: '2541' } }],
            },
      release: () => {},
    };
    (service as unknown as { pool: unknown }).pool = { connect: async () => client };
    const report = await service.list(
      new Date('2026-10-01T00:00:00Z'),
      new Date('2026-10-02T00:00:00Z'),
      10,
    );
    expect(report.financialSummaryVerified).eq(false);
    expect(report.runs[0].status).eq('NEEDS_RECONCILIATION');
    expect(report.runs[0].lastRecordedStatus).eq('SETTLED');
  });
  it('returns a real next page when more rows exist', async () => {
    const service = new B26MarketRunsService({ get: () => undefined } as unknown as ConfigService);
    const rows = [
      { id: 'a', status: 'NO_MATCH' },
      { id: 'b', status: 'SETTLED' },
      { id: 'c', status: 'NO_MATCH' },
    ];
    let sqlText = '';
    let sqlArgs: unknown[] = [];
    const client = {
      query: async (sql: string, args: unknown[] = []) => {
        if (sql.includes('session_user'))
          return { rows: [{ actor: 'b26_reporter', guarded: true }] };
        sqlText = sql;
        sqlArgs = args;
        return { rows };
      },
      release: () => {},
    };
    (service as unknown as { pool: unknown }).pool = { connect: async () => client };
    const from = new Date('2026-10-01T00:00:00Z'),
      to = new Date('2026-10-02T00:00:00Z');
    const report = await service.list(from, to, 2, 5);
    expect(report.runs).toMatchObject([{ id: 'a' }, { id: 'b' }]);
    expect(report.hasMore).eq(true);
    expect(report.nextOffset).eq(7);
    expect(report.financialSummaryVerified).eq(false);
    expect(sqlText).toContain('LIMIT $3 OFFSET $4');
    expect(sqlArgs).deep.eq([from, to, 3, 5]);
  });
});
