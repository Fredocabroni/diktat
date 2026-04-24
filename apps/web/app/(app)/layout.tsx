// Logged-in shell: persistent bottom tab bar that respects the iOS safe-
// area inset. Pages under this segment render inside `<main>`; nav lives
// outside so it stays fixed as content scrolls. Auth gate runs server-
// side so the bottom tabs never flash for signed-out visitors.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { InstallPrompt } from '../../components/InstallPrompt';
import { SessionLengthNudge } from '../../components/SessionLengthNudge';
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

  // First-run users land on the onboarding flow. We fetch onboarded_at
  // here (one small row) rather than a full profile join — the tab pages
  // fetch what they need via tRPC.
  const profileResult = await supabase
    .from('users')
    .select('onboarded_at')
    .eq('id', user.id)
    .maybeSingle<{ onboarded_at: string | null }>();
  const profile = profileResult.data;
  if (profile && !profile.onboarded_at) redirect('/onboard/welcome');

  return (
    <>
      <main className="min-h-dvh pb-[calc(env(safe-area-inset-bottom)+72px)] pt-[env(safe-area-inset-top)]">
        {children}
      </main>
      <InstallPrompt />
      <SessionLengthNudge />
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
