// Topic picker + matchmaking flow. Client-side so it can run the queue
// poll (`matchmaking.getStatus` every 2s) without re-rendering the server
// segment. When status flips to `matched`, routes to /battles/[battleId]
// and the URL-side dispatcher picks open_debate vs trivia.
//
// State sequence:
//   idle      → topic list, Find-a-partner CTA disabled until selection
//   waiting   → "Looking for a sparring partner…" + poll
//   (route)   → router.push on `matched`

'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { trpc } from '../../../../lib/trpc';

export interface TopicRow {
  readonly id: string;
  readonly headline: string;
  readonly category: string | null;
  readonly primary_source_url: string | null;
}

interface MatchmakingEntryProps {
  readonly topics: ReadonlyArray<TopicRow>;
}

export function MatchmakingEntry({ topics }: MatchmakingEntryProps): React.JSX.Element {
  const router = useRouter();
  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);

  const enqueue = trpc.matchmaking.enqueue.useMutation({
    onSuccess: () => setWaiting(true),
  });

  // Poll matchmaking status while waiting. Stops once matched (or if the
  // user navigates away — React Query disables on unmount).
  const status = trpc.matchmaking.getStatus.useQuery(
    { mode: 'open_debate' },
    {
      refetchInterval: 2_000,
      enabled: waiting,
    },
  );

  // On mount, check status once — if the user already enqueued in a prior
  // session and refreshed, jump straight to the waiting state.
  const initialStatus = trpc.matchmaking.getStatus.useQuery(
    { mode: 'open_debate' },
    { enabled: !waiting },
  );

  useEffect(() => {
    if (!waiting && initialStatus.data?.status === 'waiting') {
      setWaiting(true);
    }
  }, [initialStatus.data, waiting]);

  useEffect(() => {
    const matched = status.data?.status === 'matched' ? status.data : null;
    if (matched) {
      router.push(`/battles/${matched.battleId}`);
    }
  }, [status.data, router]);

  if (topics.length === 0) {
    return (
      <p className="rounded-2xl border border-ink-300 bg-surface-card p-6 text-text-secondary">
        No topics yet. Check back once topics drop.
      </p>
    );
  }

  if (waiting) {
    return (
      <div className="rounded-2xl border border-ink-300 bg-surface-card p-6 text-center">
        <p className="font-display text-lg font-semibold text-text-primary">
          Looking for a sparring partner.
        </p>
        <p className="mt-2 text-sm text-text-secondary">Matching you with someone close in AP.</p>
      </div>
    );
  }

  return (
    <>
      <ul className="flex flex-col gap-2">
        {topics.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              onClick={() => setSelectedTopicId(t.id)}
              aria-pressed={selectedTopicId === t.id}
              className={`w-full rounded-2xl border p-4 text-left transition ${
                selectedTopicId === t.id
                  ? 'border-brand bg-brand/10'
                  : 'border-ink-300 bg-surface-card hover:border-ink-400'
              }`}
            >
              <p className="font-display font-semibold text-text-primary">{t.headline}</p>
              {t.category ? (
                <p className="mt-1 text-xs uppercase tracking-wide text-text-secondary">
                  {t.category}
                </p>
              ) : null}
            </button>
          </li>
        ))}
      </ul>

      <button
        type="button"
        disabled={!selectedTopicId || enqueue.isPending}
        onClick={() => {
          if (selectedTopicId) {
            enqueue.mutate({ mode: 'open_debate', topicId: selectedTopicId });
          }
        }}
        className="mt-6 w-full rounded-full bg-brand px-6 py-3 font-semibold text-brand-fg transition disabled:opacity-50"
      >
        {enqueue.isPending ? 'Joining.' : 'Find a sparring partner'}
      </button>

      {enqueue.error ? <p className="mt-4 text-sm text-danger">{enqueue.error.message}</p> : null}
    </>
  );
}
