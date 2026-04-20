// OAuth / magic-link callback. Supabase redirects here with a `code` in
// the query string; we exchange it for a session (cookie set by the
// server client), then send the visitor home. The trigger on auth.users
// has already provisioned their public.users/wallets/streaks rows by
// the time we land here.

import { NextResponse } from 'next/server';

import { getServerSupabaseClient } from '../../../lib/supabase/server';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');

  if (code) {
    const supabase = await getServerSupabaseClient();
    await supabase.auth.exchangeCodeForSession(code);
  }

  return NextResponse.redirect(new URL('/', url.origin));
}
