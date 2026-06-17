// Generate a magic link + OTP for a given email via the Supabase Admin API.
// Bypasses email delivery (which isn't wired yet — Resend SMTP TODOs).
//
// Usage:
//   (set -a; . .env.local; set +a; node scripts/dev-magic-link.mjs <email> [redirectOrigin])
//   redirectOrigin defaults to the Vercel preview URL for PR #40.

import { createClient } from '@supabase/supabase-js';

const email = process.argv[2];
const redirectOrigin =
  process.argv[3] || 'https://diktat-web1-git-feat-drop-ui-4-2-fredocabronis-projects.vercel.app';

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
  options: { redirectTo: `${redirectOrigin}/auth/callback` },
});

if (error) {
  console.error('admin.generateLink failed:', error.message);
  process.exit(1);
}

console.log('=== magic link ===');
console.log('email :', data?.user?.email ?? email);
console.log('OTP   :', data?.properties?.email_otp ?? '(none returned)');
console.log('expires:', data?.properties?.verification_type, '·', data?.properties?.email_otp_expires_at ?? '(default)');
console.log('');
console.log('Option A — click the link directly:');
console.log(data?.properties?.action_link);
console.log('');
console.log('Option B — type the 6-digit OTP into the login form:');
console.log('         ', data?.properties?.email_otp);
