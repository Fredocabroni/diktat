// Modern email-link callback. Uses Supabase's `verifyOtp({ token_hash, type })`
// path for any magic-link, invite, signup, recovery, or email-change link that
// carries `?token_hash=…&type=…` directly. Unlike `/auth/callback`, this path
// does NOT depend on a PKCE `code_verifier` cookie being set on the browser
// session beforehand — so it works for admin-generated links (the dev login
// tool) and for the production Resend email templates that will use
// `{{ .TokenHash }}` once the SMTP TODO lands.
//
// On success: session cookies are written via the @supabase/ssr cookie
// adapter (same path the existing PKCE route uses) and the visitor is sent
// home. On failure (expired/replayed token, missing params, bad type) we
// log and bounce to /login with an error flag — same codes the existing
// login page already maps to user-facing copy.

import { NextResponse } from 'next/server';

import { getServerSupabaseClient } from '../../../lib/supabase/server';

// Supabase's verifyOtp accepts a constrained set of `type` strings for the
// token-hash flow. Validate at the route boundary so a crafted query param
// can't drive the SDK toward an unintended verification path.
const ALLOWED_TYPES = new Set([
  'email',
  'magiclink',
  'signup',
  'invite',
  'recovery',
  'email_change',
]);

type EmailOtpType = 'email' | 'magiclink' | 'signup' | 'invite' | 'recovery' | 'email_change';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const tokenHash = url.searchParams.get('token_hash');
  const type = url.searchParams.get('type');

  if (!tokenHash || !type || !ALLOWED_TYPES.has(type)) {
    return NextResponse.redirect(new URL('/login?error=missing_code', url.origin));
  }

  const supabase = await getServerSupabaseClient();
  const { error } = await supabase.auth.verifyOtp({
    token_hash: tokenHash,
    type: type as EmailOtpType,
  });

  if (error) {
    console.error('auth.confirm.verify_failed', {
      status: error.status,
      code: error.code,
      name: error.name,
    });
    return NextResponse.redirect(new URL('/login?error=exchange_failed', url.origin));
  }

  return NextResponse.redirect(new URL('/', url.origin));
}
