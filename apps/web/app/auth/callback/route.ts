// OAuth / magic-link callback. Supabase redirects here with a `code` in
// the query string; we exchange it for a session (cookie set by the
// server client), then send the visitor home. The trigger on auth.users
// has already provisioned their public.users/wallets/streaks rows by
// the time we land here.
//
// On failure (expired/replayed code, PKCE mismatch, network error) we log
// and bounce back to /login with an error flag so the auth failure is
// visible both to the user and to server logs. Silently redirecting to /
// hides PKCE replay attempts and expired-code UX dead-ends.

import { NextResponse } from 'next/server';

import { getServerSupabaseClient } from '../../../lib/supabase/server';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');

  if (!code) {
    return NextResponse.redirect(new URL('/login?error=missing_code', url.origin));
  }

  const supabase = await getServerSupabaseClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    console.error('auth.callback.exchange_failed', {
      status: error.status,
      code: error.code,
      name: error.name,
    });
    return NextResponse.redirect(new URL('/login?error=exchange_failed', url.origin));
  }

  return NextResponse.redirect(new URL('/', url.origin));
}
