// Battle URL dispatcher. The URL space is shared across modes so links
// from anywhere (matchmaking, future Drop CTAs, notifications) don't
// need to know which mode they're pointing at -- the server segment
// reads `battles.mode` once and renders the right client island.

import { notFound } from 'next/navigation';

import { OpenDebateClient } from '../../../../components/open-debate/OpenDebateClient';
import { getServerSupabaseClient } from '../../../../lib/supabase/server';

import { BattleClient } from './BattleClient';

interface PageProps {
  readonly params: Promise<{ id: string }>;
}

interface BattleModeRow {
  readonly mode: 'trivia' | 'open_debate' | 'voice_debate';
}

export default async function BattleByIdPage({ params }: PageProps) {
  const { id } = await params;
  const supabase = await getServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) notFound();

  const { data: battle } = await supabase
    .from('battles')
    .select('mode')
    .eq('id', id)
    .maybeSingle<BattleModeRow>();
  if (!battle) notFound();

  return (
    <section className="mx-auto max-w-md px-4 py-6">
      {battle.mode === 'open_debate' ? (
        <OpenDebateClient battleId={id} currentUserId={user.id} />
      ) : (
        <BattleClient battleId={id} />
      )}
    </section>
  );
}
