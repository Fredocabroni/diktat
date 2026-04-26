// Phase 3 partial: feed shell. The placeholder topics below render the
// SwipeCard primitive so the layout, action buttons, and Battle CTA are
// real on staging. Real news_topics rows land in the follow-up PR
// alongside the seed list approved on PR #19.
//
// "Battle This" is a no-op until PR #17 (matchmaking router) lands —
// the click logs to the console so we can verify event wiring without
// committing to the matchmaking enqueue surface yet.

import { FeedClient } from './FeedClient';

const PLACEHOLDER_TOPICS = [
  {
    id: 'placeholder-1',
    headline: 'Senate floor schedules a vote on the FY 2027 continuing resolution',
    summary:
      'Procedural cloture filed Monday; final-passage vote expected Thursday after a week of negotiations on disaster supplemental amendments.',
    primarySource: { label: 'Congress.gov', url: 'https://www.congress.gov/' },
  },
  {
    id: 'placeholder-2',
    headline: 'BLS releases April nonfarm payrolls report',
    summary:
      'Preliminary data shows 187k jobs added; unemployment unchanged at 4.0%. Revisions to February and March reduce the prior two-month total by 41k.',
    primarySource: { label: 'BLS', url: 'https://www.bls.gov/' },
  },
  {
    id: 'placeholder-3',
    headline: 'SCOTUS denies cert in pending state-redistricting challenge',
    summary:
      'Court declines to hear the appeal without comment, leaving the lower-court ruling in place ahead of the November cycle.',
    primarySource: {
      label: 'Supreme Court of the United States',
      url: 'https://www.supremecourt.gov/',
    },
  },
] as const;

export default function HomePage() {
  return (
    <section className="mx-auto max-w-md px-4 py-6">
      <header className="mb-4">
        <h1 className="font-display text-2xl font-bold">Feed</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Placeholder topics — real Drop content lands when PR #19 final ships.
        </p>
      </header>
      <FeedClient topics={[...PLACEHOLDER_TOPICS]} />
    </section>
  );
}
