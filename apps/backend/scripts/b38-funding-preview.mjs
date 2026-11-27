import { JsonRpcProvider, Contract, formatUnits } from 'ethers';
import pg from 'pg';

const day = process.argv[2];

if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? '')) {
  throw new Error('Expected simulation date YYYY-MM-DD');
}

const start = new Date(`${day}T00:00:00.000Z`);

if (!Number.isFinite(start.valueOf()) || start.toISOString().slice(0, 10) !== day) {
  throw new Error('Invalid simulation date');
}

const end = new Date(start.getTime() + 86400000);

const TOKEN = '0x5B529135D699244D1247877353EaFdC429892bed';

const ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

if (process.env.HEDERA_NETWORK !== 'testnet') {
  throw new Error('Only Hedera Testnet is supported');
}

const provider = new JsonRpcProvider(process.env.HEDERA_TESTNET_RPC_URL);

const db = new pg.Client({
  connectionString: process.env.DATABASE_URL,
});

async function main() {
  try {
    const network = await provider.getNetwork();

    if (network.chainId !== 296n) {
      throw new Error('Incorrect Hedera network');
    }

    const token = new Contract(TOKEN, ABI, provider);

    const decimals = Number(await token.decimals());
    const symbol = await token.symbol();

    if (decimals !== 6 || symbol !== 'TEUSD') {
      throw new Error('Unexpected TEUSD token');
    }

    await db.connect();

    await db.query('BEGIN READ ONLY');

    const { rows } = await db.query(
      `
            SELECT
                a."buyerAddress" AS address,
                COUNT(*)::int AS allocations,
                SUM(a."amountBaseUnits")::text AS required
            FROM "V2Allocation" a
            JOIN "V2Market" m
                ON m.id = a."marketId"
            JOIN "V2AllocationPlan" p
                ON p.id = a."planId"
            WHERE m."intervalStart" >= $1
              AND m."intervalStart" < $2
              AND m.namespace = 'hourly'
              AND m.mode = 'HOURLY'
              AND a.status = 'VALIDATED'
              AND p.status = 'AUTHORITATIVE'
            GROUP BY a."buyerAddress"
            ORDER BY a."buyerAddress"
        `,
      [start, end],
    );

    const results = [];
    let totalRequired = 0n;
    let totalDeficit = 0n;

    for (const row of rows) {
      const required = BigInt(row.required);

      const [teusdBalance, hbarBalance] = await Promise.all([
        token.balanceOf(row.address),
        provider.getBalance(row.address),
      ]);

      const deficit = required > teusdBalance ? required - teusdBalance : 0n;

      totalRequired += required;
      totalDeficit += deficit;

      results.push({
        buyer: row.address,
        allocations: row.allocations,
        requiredTEUSD: formatUnits(required, 6),
        availableTEUSD: formatUnits(teusdBalance, 6),
        deficitTEUSD: formatUnits(deficit, 6),
        availableHBAR: formatUnits(hbarBalance, 18),
      });
    }

    console.table(results);

    console.log(
      'SUMMARY',
      JSON.stringify(
        {
          day,
          chainId: network.chainId.toString(),
          buyers: rows.length,
          allocations: rows.reduce((n, r) => n + r.allocations, 0),
          totalRequiredTEUSD: formatUnits(totalRequired, 6),
          totalDeficitTEUSD: formatUnits(totalDeficit, 6),
        },
        null,
        2,
      ),
    );

    console.log('PASS: Read-only wallet balance inspection.');

    await db.query('ROLLBACK');
  } finally {
    await db.end().catch(() => {});
    provider.destroy();
  }
}

main().catch(() => {
  console.error('B38 FUNDING PREVIEW FAILED');
  process.exitCode = 1;
});
