// Logged-in shell: persistent bottom tab bar that respects the iOS safe-
// area inset. Pages under this segment render inside `<main>`; nav lives
// outside so it stays fixed as content scrolls. Auth gate runs server-
// side so the bottom tabs never flash for signed-out visitors.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { InstallPrompt } from '../../components/InstallPrompt';
import { SessionLengthNudge } from '../../components/SessionLengthNudge';
import { TierUpCelebration } from '../../components/tier-up/TierUpCelebration';
import { getServerSupabaseClient } from '../../lib/supabase/server';

const TABS = [
  { href: '/', label: 'Home' },
  { href: '/battles', label: 'Battles' },
  { href: '/wallet', label: 'Wallet' },
  { href: '/profile', label: 'Profile' },
] as const;

export default async function AppLayout({ children }: { children: ReactNode }) {
  const supabase = await getServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // First-run users land on the onboarding flow. `onboarded_at` is a
  // private column on public.users — unreachable via direct PostgREST
  // SELECT as the `authenticated` role per the column-grant audit
  // (migration 20260617160000) and the H1 fix (20260618120000). The
  // self-only `get_user_self()` RPC is the only path. Same self-lock
  // as the original .eq('id', user.id) shape — the function locks to
  // auth.uid() inside its body.
  //
  // Error posture (PR #44 round-2 security-reviewer MEDIUM-1, extended
  // for #127 audit H12):
  // - Fail-open (the round-1 shape) lets an un-onboarded user reach
  //   the authenticated shell on any transient RPC error.
  // - Fail-closed (redirect to /onboard/welcome on error) bounces an
  //   already-onboarded user back into the onboarding flow, because
  //   the onboarding entry is a client page that does NOT re-validate
  //   `onboarded_at` server-side — it just renders + calls
  //   `completeOnboarding` on tap. The redirect would be sticky on
  //   subsequent transient errors and the only escape is the
  //   idempotent stamp of completeOnboarding (which works, but is a
  //   jarring extra click for someone already onboarded).
  // - So: one retry, then render an inline error and let the user
  //   refresh. Closes the fail-open without trapping onboarded users.
  //
  // A `null` profile is treated identically to an RPC error. When
  // `get_user_self()` succeeds but returns zero rows (e.g. `handle_new_user`
  // trigger failed post-auth-insert, or the `public.users` row was manually
  // removed), the earlier `if (profile && !profile.onboarded_at)` guard
  // short-circuited to false and let the un-onboarded, handle-less user
  // reach the authenticated shell — where every component that assumes a
  // valid handle breaks. There is no product state in which reaching the
  // shell without a public.users row is correct; render the same inline
  // error as the RPC-error branch.
  let profileResult = await supabase.rpc('get_user_self');
  if (profileResult.error) {
    profileResult = await supabase.rpc('get_user_self');
  }
  const profile = profileResult.error
    ? null
    : ((profileResult.data?.[0] ?? null) as { onboarded_at: string | null } | null);
  if (!profile) {
    // Recovery affordance (#148). The fail-closed branch above was a dead
    // end — refresh keeps looping back here when the public.users row
    // genuinely doesn't exist (rare: handle_new_user trigger failure at
    // signup). A mailto gives the user a known escape to a human. Option
    // (a) from the issue; (b) server-side repair RPC is deferred until
    // the incident rate warrants it.
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6">
        <h1 className="font-display text-2xl font-bold text-text-primary">
          Couldn&rsquo;t load your profile.
        </h1>
        <p className="mt-3 text-sm text-text-secondary">
          Refresh to try again. If it keeps failing, email{' '}
          <a
            href="mailto:support@diktat.app?subject=Can%27t%20load%20my%20profile"
            className="text-text-primary underline underline-offset-2 hover:text-brand-accent"
          >
            support@diktat.app
          </a>{' '}
          with your account email and we&rsquo;ll fix it.
        </p>
      </main>
    );
  }
  if (!profile.onboarded_at) redirect('/onboard/welcome');

  return (
    <>
      <main className="min-h-dvh pb-[calc(env(safe-area-inset-bottom)+72px)] pt-[env(safe-area-inset-top)]">
        {children}
      </main>
      <InstallPrompt />
      <SessionLengthNudge />
      <TierUpCelebration />
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-ink-300 bg-surface-app/90 pb-[env(safe-area-inset-bottom)] backdrop-blur"
      >
        <ul className="mx-auto flex max-w-md items-stretch justify-between px-4 py-2">
          {TABS.map((tab) => (
            <li key={tab.href} className="flex-1">
              <Link
                href={tab.href}
                className="flex h-12 flex-col items-center justify-center gap-0.5 rounded-xl text-xs text-text-secondary hover:text-text-primary"
              >
                <span className="font-medium">{tab.label}</span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}
