// Wallet tab. Shows AP balance + USD-shown-as-USDC line, a paginated
// transactions feed, and (for tiers 0–2) the ghost-earnings card.
//
// No crypto surface language. USDC is the rail; users see "USD".

'use client';

import { GhostEarningsCard } from '../../../components/wallet/GhostEarningsCard';
import { TransactionRow } from '../../../components/wallet/TransactionRow';
import { trpc } from '../../../lib/trpc';

const PAGE_SIZE = 50;

export default function WalletPage() {
  const balance = trpc.wallet.balance.useQuery();
  const transactions = trpc.wallet.transactions.useInfiniteQuery(
    { limit: PAGE_SIZE },
    { getNextPageParam: (last) => last.nextCursor ?? undefined },
  );

  const rows = transactions.data?.pages.flatMap((p) => p.items) ?? [];
  const tier = balance.data?.tierId ?? 0;
  const showGhost = tier <= 2;

  return (
    <section className="mx-auto max-w-md space-y-4 px-4 py-6">
      <header>
        <h1 className="font-display text-3xl font-bold tracking-tight text-text-primary">Wallet</h1>
      </header>

      <div className="rounded-2xl border border-ink-300 bg-surface-card p-5">
        <p className="text-xs uppercase tracking-wide text-text-tertiary">Arena Points</p>
        <p className="mt-1 font-display text-4xl font-bold text-text-primary">
          {balance.isLoading ? '—' : (balance.data?.currentAp ?? 0)}
        </p>
        <div className="mt-4 flex items-baseline justify-between border-t border-ink-200 pt-3">
          <p className="text-sm text-text-secondary">USD balance</p>
          <p className="font-display text-lg font-bold text-text-primary">
            ${balance.isLoading ? '—' : (balance.data?.usd.toFixed(2) ?? '0.00')}
          </p>
        </div>
        <p className="mt-1 text-xs text-text-tertiary">Held as USDC, shown in USD.</p>
      </div>

      {showGhost && <GhostEarningsCard />}

      <div>
        <h2 className="mb-2 text-xs uppercase tracking-wide text-text-tertiary">Transactions</h2>
        {transactions.isLoading ? (
          <p className="text-sm text-text-secondary">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="rounded-2xl border border-ink-300 bg-surface-card p-4 text-sm text-text-secondary">
            No activity yet. Your first battle lands here.
          </p>
        ) : (
          <ul className="space-y-2">
            {rows.map((tx) => (
              <TransactionRow
                key={tx.id}
                id={tx.id}
                delta={tx.delta}
                balanceAfter={tx.balance_after}
                reason={tx.reason}
                createdAt={tx.created_at}
              />
            ))}
          </ul>
        )}
        {transactions.hasNextPage && (
          <button
            type="button"
            onClick={() => transactions.fetchNextPage()}
            disabled={transactions.isFetchingNextPage}
            className="mt-3 w-full rounded-full border border-ink-400 py-3 text-sm font-semibold text-text-secondary transition hover:border-ink-500 hover:text-text-primary disabled:opacity-60"
          >
            {transactions.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>
    </section>
  );
}
