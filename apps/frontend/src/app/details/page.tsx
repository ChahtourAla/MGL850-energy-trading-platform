import Link from 'next/link';
import MatchingHistoryPanel from '../../components/MatchingHistoryPanel';
import TradeLifecyclePanel from '../../components/TradeLifecyclePanel';
import B30AllHouseholds from '../../components/B30AllHouseholds';

type Query = { userId?: string; from?: string; to?: string };

export default async function DetailsPage({ searchParams }: { searchParams: Promise<Query> }) {
  const params = await searchParams;
  const validDate = (value: unknown): value is string =>
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const from = validDate(params.from) ? params.from : '2026-11-10';
  const to = validDate(params.to) ? params.to : '2026-11-11';
  const userId = params.userId && /^[0-9a-fA-F-]{36}$/.test(params.userId) ? params.userId : null;
  const back = `/?${new URLSearchParams({ ...(userId ? { userId } : {}), from, to })}`;

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-8 text-slate-100 sm:px-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <Link href={back} className="inline-flex rounded-lg px-1 py-2 text-sm font-medium text-cyan-300 hover:text-cyan-200 focus-visible:outline-2 focus-visible:outline-cyan-300">
          ← Back to dashboard
        </Link>
        <header className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
          <p className="text-xs font-bold uppercase tracking-widest text-cyan-400">Additional information</p>
          <h1 className="mt-2 text-2xl font-bold">Explore trading details</h1>
          <p className="mt-2 text-sm text-slate-400">
            Optional records for exploring how energy matches and trades were created. Payment verification belongs to the main Electricity Trading History table.
          </p>
        </header>
        {userId && (
          <section className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
            <MatchingHistoryPanel userId={userId} from={`${from}T00:00:00Z`} to={`${to}T00:00:00Z`} />
          </section>
        )}
        <section className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
          <B30AllHouseholds from={`${from}T00:00:00Z`} to={`${to}T00:00:00Z`} />
        </section>
        {userId && (
          <details className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
            <summary className="cursor-pointer text-lg font-semibold text-cyan-300">Technical trading records</summary>
            <p className="mt-3 text-sm text-slate-400">Historical matching and processing diagnostics for reviewers. This is not the payment verification view.</p>
            <div className="mt-4">
              <TradeLifecyclePanel userId={userId} from={`${from}T00:00:00Z`} to={`${to}T00:00:00Z`} />
            </div>
          </details>
        )}
      </div>
    </main>
  );
}
