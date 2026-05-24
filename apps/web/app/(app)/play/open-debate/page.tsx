// Open Debate matchmaking entry. Server segment fetches the topic list
// (anon-readable RLS — no auth needed for read), then renders the client
// matchmaking flow. Auth itself is enforced by the (app) layout above.
//
// Topic-picker stub: 4.6 lists `news_topics` as-is. PR 4.2 will replace
// this entry path with embedded "Battle This" CTAs on Drop content.

import { getServerSupabaseClient } from '../../../../lib/supabase/server';
import { MatchmakingEntry, type TopicRow } from './MatchmakingEntry';

export const dynamic = 'force-dynamic';

export default async function OpenDebateEntryPage() {
  const supabase = await getServerSupabaseClient();
  const { data: topics } = await supabase
    .from('news_topics')
    .select('id, headline, category, primary_source_url')
    .order('created_at', { ascending: false })
    .limit(25)
    .returns<TopicRow[]>();

  return (
    <section className="mx-auto max-w-md px-4 py-6">
      <header className="mb-6">
        <h1 className="font-display text-2xl font-bold text-text-primary">Open Debate</h1>
        <p className="mt-2 text-sm text-text-secondary">
          Pick what you&apos;re arguing about. Three rounds. Community votes the winner.
        </p>
      </header>
      <MatchmakingEntry topics={topics ?? []} />
    </section>
  );
}
