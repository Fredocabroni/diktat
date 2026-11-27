// US + US-territory ISO 3166-1 alpha-2 codes allowed through the
// pre-launch country gate. Vercel's `x-vercel-ip-country` header and
// MaxMind GeoLite both report the five permanently inhabited US
// territories as distinct codes (not `US`); the earlier
// `country !== 'US'` check was blocking residents of Puerto Rico,
// Guam, the US Virgin Islands, American Samoa and the Northern
// Mariana Islands. Those residents are US persons for every purpose
// that matters here.
//
// Single source of truth for the web layer (login page client gate +
// /auth/callback edge). The Supabase auth hook keeps its own copy of
// the same list in SQL — there is no cross-language import boundary
// we can share here. Keep them in lockstep.
export const US_ALLOWED_COUNTRIES: readonly string[] = [
  'US',
  'PR', // Puerto Rico
  'GU', // Guam
  'VI', // US Virgin Islands
  'AS', // American Samoa
  'MP', // Northern Mariana Islands
];

export function isAllowedCountry(code: string | null | undefined): boolean {
  if (!code) return true;
  return US_ALLOWED_COUNTRIES.includes(code.toUpperCase());
}
