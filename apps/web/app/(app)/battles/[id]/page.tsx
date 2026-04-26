// Live trivia battle screen. Server segment validates the battle id
// shape and forwards to the client island, which owns 1-second polling
// of trpc.battles.getRound. Real-time UI without WebSockets — we swap
// to Supabase Realtime in Phase 4 if scale demands it.

import { BattleClient } from './BattleClient';

interface PageProps {
  readonly params: Promise<{ id: string }>;
}

export default async function BattleByIdPage({ params }: PageProps) {
  const { id } = await params;
  return (
    <section className="mx-auto max-w-md px-4 py-6">
      <BattleClient battleId={id} />
    </section>
  );
}
