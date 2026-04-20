// Typed reads of the NEXT_PUBLIC_* env vars the PWA needs. Validation is
// lazy so a missing var only blows up when the code that needs it runs —
// otherwise `next build` (which doesn't have runtime env on Vercel until
// the dyno boots) couldn't collect page data.

function required(name: string, value: string | undefined): string {
  if (!value || value.length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export const clientEnv = {
  get SUPABASE_URL() {
    return required('NEXT_PUBLIC_SUPABASE_URL', process.env.NEXT_PUBLIC_SUPABASE_URL);
  },
  get SUPABASE_ANON_KEY() {
    return required('NEXT_PUBLIC_SUPABASE_ANON_KEY', process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  },
  get API_URL() {
    return process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
  },
  get X_OAUTH_ENABLED() {
    return process.env.NEXT_PUBLIC_X_OAUTH_ENABLED === 'true';
  },
} as const;
