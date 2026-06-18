// Generate a magic link + OTP for a given email via the Supabase Admin API.
// Bypasses email delivery (which isn't wired yet — Resend SMTP TODOs).
//
// Emits an `/auth/confirm` URL that hits the app's modern token-hash
// callback (apps/web/app/auth/confirm/route.ts) directly. That route calls
// `supabase.auth.verifyOtp({ token_hash, type })` and sets the session
// cookies via the @supabase/ssr cookie adapter. No PKCE handshake needed,
// so admin-generated links work from a fresh browser session.
//
// Usage:
//   (set -a; . .env.local; set +a; node scripts/dev-magic-link.mjs <email> [redirectOrigin])
//   redirectOrigin defaults to the production Vercel alias; pass the
//   PR-preview origin to target a specific deploy.

import { createClient } from '@supabase/supabase-js';

const email = process.argv[2];
const redirectOrigin = process.argv[3] || 'https://diktat-web1.vercel.app';

if (!email) {
  console.error('Usage: node scripts/dev-magic-link.mjs <email> [redirectOrigin]');
  process.exit(2);
}

const sr = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { data, error } = await sr.auth.admin.generateLink({
  type: 'magiclink',
  email,
  // `redirectTo` here only feeds Supabase's email-template placeholder
  // and the action_link fallback. The /auth/confirm URL we build below
  // doesn't go through Supabase's verify endpoint at all — we hand the
  // token_hash to the app, which calls verifyOtp server-side.
  options: { redirectTo: `${redirectOrigin}/auth/callback` },
});

if (error) {
  console.error('admin.generateLink failed:', error.message);
  process.exit(1);
}

const tokenHash = data?.properties?.hashed_token;
const otp = data?.properties?.email_otp;
const verificationType = data?.properties?.verification_type ?? 'magiclink';

const confirmUrl = tokenHash
  ? `${redirectOrigin}/auth/confirm?token_hash=${encodeURIComponent(tokenHash)}&type=${encodeURIComponent(verificationType)}`
  : null;

console.log('=== magic link ===');
console.log('email :', data?.user?.email ?? email);
console.log('OTP   :', otp ?? '(none returned)');
console.log('type  :', verificationType);
console.log('');
console.log('Option A — click this /auth/confirm link directly:');
console.log(confirmUrl ?? '(no hashed_token in admin response)');
console.log('');
console.log('Option B — type the 6-digit OTP into the login form:');
console.log('         ', otp);
