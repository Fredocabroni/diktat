// Client island that drives the feed primitives. Calls
// `feed.recordShift` on agree/disagree (no-op-equivalent skip), and
// stubs the Battle CTA until the matchmaking router lands.

'use client';

import { BattleThisCta, SwipeCard, type SwipeAction, type SwipeCardTopic } from '@diktat/ui';
import { useCallback, useState } from 'react';

import { trpc } from '../../lib/trpc';

interface FeedClientProps {
  readonly topics: ReadonlyArray<SwipeCardTopic>;
}

export function FeedClient({ topics }: FeedClientProps) {
  const [index, setIndex] = useState(0);
  const recordShift = trpc.feed.recordShift.useMutation();

  const advance = useCallback(() => {
    setIndex((i) => Math.min(i + 1, topics.length - 1));
  }, [topics.length]);

  const onAction = useCallback(
    (action: SwipeAction, topicId: string) => {
      if (action !== 'skip') {
        recordShift.mutate({
          topicId,
          beforePosition: 0,
          afterPosition: action === 'agree' ? 1 : -1,
        });
      }
      advance();
    },
    [advance, recordShift],
  );

  const onBattleClick = useCallback((_topicId: string) => {
    // Wired in the follow-up after PR #17 (matchmaking router) lands.
    // The button is rendered `disabled` on the placeholder page so a
    // user can't trigger this path — addiction-auditor §12: a live-
    // looking button that silently no-ops fails the trust test.
  }, []);

  const topic = topics[index];
  if (!topic) {
    return (
      <div className="rounded-2xl border border-ink-300 bg-surface-card p-6 text-center text-text-secondary">
        That&rsquo;s the last placeholder. Real Drop content lands when PR #19 final ships.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <SwipeCard
        topic={topic}
        onAction={onAction}
        battleCta={<BattleThisCta topicId={topic.id} onClick={onBattleClick} disabled />}
      />
      <p className="text-center text-xs text-text-secondary">
        {index + 1} of {topics.length}
      </p>
    </div>
  );
}
