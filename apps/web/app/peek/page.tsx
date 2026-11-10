// "Look around first" off-ramp from onboarding. CLAUDE.md §
// "Onboarding 'look around first' off-ramp" + ADDICTION_ARCHITECTURE
// §10 (autonomy): un-onboarded users can peek at today's Drop in
// read-only mode before committing to a tribe.
//
// Auth gate: requires sign-in (same posture as the (app) shell). But
// deliberately does NOT redirect on `onboarded_at IS NULL` — this
// route IS the pre-onboarding preview. Age gate still applies (18+
// is a product requirement, not an onboarding step).

import { redirect } from 'next/navigation';

import { getServerSupabaseClient } from '../../lib/supabase/server';
import { PeekClient } from './PeekClient';

export const dynamic = 'force-dynamic';

export default async function PeekPage() {
  const supabase = await getServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // Re-use the same self-only profile RPC the (app) shell uses so the
  // age-gate ordering stays consistent. One retry on transient RPC
  // error; a null profile short-circuits to the same inline error
  // affordance the shell renders.
  let profileResult = await supabase.rpc('get_user_self');
  if (profileResult.error) {
    profileResult = await supabase.rpc('get_user_self');
  }
  const profile = profileResult.error
    ? null
    : ((profileResult.data?.[0] ?? null) as {
        onboarded_at: string | null;
        age_verified_at: string | null;
        age_blocked_at: string | null;
      } | null);
  if (!profile) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6">
        <h1 className="font-display text-2xl font-bold text-text-primary">
          Couldn&rsquo;t load your profile.
        </h1>
        <p className="mt-3 text-sm text-text-secondary">refresh to try again.</p>
      </main>
    );
  }
  // Age gates come before onboarding by design — a blocked / unverified
  // user cannot peek either.
  if (profile.age_blocked_at) redirect('/not-eligible');
  if (!profile.age_verified_at) redirect('/onboard/age');

  // If the user IS already onboarded, there's nothing to peek — send
  // them home. Keeps /peek as a strictly pre-onboarding surface.
  if (profile.onboarded_at) redirect('/');

  return <PeekClient />;
}
