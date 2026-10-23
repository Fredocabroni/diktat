// OAuth / magic-link callback. Supabase redirects here with a `code` in
// the query string; we exchange it for a session (cookie set by the
// server client), then send the visitor home. The trigger on auth.users
// has already provisioned their public.users/wallets/streaks rows by
// the time we land here.
//
// US-only pre-launch gate: before exchanging the code we check
// `x-vercel-ip-country` on this inbound request. A non-US value refuses
// the exchange entirely — no session cookie is set — and redirects to
// /login with the not_us error flag. Vercel sets the header at the edge
// so a client cannot forge it; this is the server-side enforcement
// point for the /login client-side gate.
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

  // Vercel-edge country tag. Empty / absent → unknown (local dev, bad
  // lookup). Unknown allows the exchange — same posture as /login's
  // client-side gate. A non-US value refuses the exchange so no cookie
  // is set and the client cannot land in /onboard/age at all.
  const country = (request.headers.get('x-vercel-ip-country') ?? '').toUpperCase();
  if (country && country !== 'US') {
    return NextResponse.redirect(new URL('/login?error=not_us', url.origin));
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
