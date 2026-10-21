// Source-pin tests for the Content-Security-Policy-Report-Only header
// in next.config.mjs. vitest runs the apps/web suite in Node — Next's
// `headers()` is not exercised at test time — so these tests assert the
// structural invariants the operator contract depends on by reading the
// config as text.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const CONFIG = readFileSync(new URL('../../next.config.mjs', import.meta.url), 'utf8');

describe('CSP header — Report-Only posture', () => {
  it('ships as Content-Security-Policy-Report-Only, never enforcing', () => {
    // Flipping to enforcement is a deliberate operator step documented
    // in the PR description. The initial deploy MUST stay Report-Only.
    expect(CONFIG).toMatch(/key:\s*'Content-Security-Policy-Report-Only'/);
    // Enforcement-mode key would be `key: 'Content-Security-Policy'`
    // (no `-Report-Only` suffix). Negative lookahead rejects any
    // non-Report-Only header name.
    expect(CONFIG).not.toMatch(/key:\s*'Content-Security-Policy'(?!-Report-Only)/);
  });

  it('applies to every path via source: "/:path*"', () => {
    expect(CONFIG).toMatch(/source:\s*'\/:path\*'/);
  });
});

describe('CSP header — directive set', () => {
  it("locks default-src to 'self'", () => {
    expect(CONFIG).toMatch(/'default-src':\s*\["'self'"\]/);
  });

  it("locks object-src to 'none' and frame-ancestors to 'none'", () => {
    expect(CONFIG).toMatch(/'object-src':\s*\["'none'"\]/);
    expect(CONFIG).toMatch(/'frame-ancestors':\s*\["'none'"\]/);
  });

  it("locks form-action and base-uri to 'self'", () => {
    expect(CONFIG).toMatch(/'form-action':\s*\["'self'"\]/);
    expect(CONFIG).toMatch(/'base-uri':\s*\["'self'"\]/);
  });

  it('allows Cloudflare Turnstile under script-src AND frame-src', () => {
    // Turnstile loads a script from challenges.cloudflare.com and
    // renders an iframe from the same origin. Both must be allowlisted.
    const scriptSrcMatch = CONFIG.match(/'script-src':\s*\[([\s\S]*?)\]/);
    expect(scriptSrcMatch?.[1]).toMatch(/https:\/\/challenges\.cloudflare\.com/);
    expect(CONFIG).toMatch(/'frame-src':\s*\['https:\/\/challenges\.cloudflare\.com'\]/);
  });

  it('allows Supabase REST (https) + Realtime (wss) under connect-src', () => {
    // Derived at config-load time from NEXT_PUBLIC_SUPABASE_URL — the
    // supabaseConnect spread puts both https:// and wss:// of the same
    // host into the connect-src list.
    expect(CONFIG).toMatch(
      /supabaseConnect\s*=\s*supabaseHost\s*\?\s*\[`https:\/\/\$\{supabaseHost\}`,\s*`wss:\/\/\$\{supabaseHost\}`\]/,
    );
    const connectSrcMatch = CONFIG.match(/'connect-src':\s*\[([\s\S]*?)\]/);
    expect(connectSrcMatch?.[1]).toMatch(/\.\.\.supabaseConnect/);
  });

  it('allows the API origin under connect-src', () => {
    expect(CONFIG).toMatch(/apiUrl\s*=\s*process\.env\.NEXT_PUBLIC_API_URL/);
    const connectSrcMatch = CONFIG.match(/'connect-src':\s*\[([\s\S]*?)\]/);
    expect(connectSrcMatch?.[1]).toMatch(/\.\.\.apiConnect/);
  });

  it('normalises the API URL through URL() so a malformed env never leaks raw into the policy', () => {
    // Prevents a bad NEXT_PUBLIC_API_URL from noising up the directive.
    expect(CONFIG).toMatch(/function safeOrigin\(url\)\s*\{/);
    expect(CONFIG).toMatch(/apiOrigin\s*=\s*safeOrigin\(apiUrl\)/);
  });

  it('allows the service worker to register itself (worker-src self + blob:)', () => {
    expect(CONFIG).toMatch(/'worker-src':\s*\["'self'",\s*'blob:'\]/);
  });

  it('allows the PWA manifest from self', () => {
    expect(CONFIG).toMatch(/'manifest-src':\s*\["'self'"\]/);
  });
});

describe('CSP header — dev vs prod divergence', () => {
  it("includes 'unsafe-eval' in script-src only in dev (Next HMR)", () => {
    // Prod builds should NOT ship unsafe-eval. The scriptExtras ternary
    // is the only path that adds it, and only when !isProd.
    expect(CONFIG).toMatch(/scriptExtras\s*=\s*isProd\s*\?\s*\[\]\s*:\s*\["'unsafe-eval'"\]/);
  });

  it('allows localhost websockets + http only in dev', () => {
    expect(CONFIG).toMatch(
      /connectExtras\s*=\s*isProd\s*\?\s*\[\]\s*:\s*\['ws:\/\/localhost:\*',\s*'http:\/\/localhost:\*'\]/,
    );
  });

  it('emits upgrade-insecure-requests only in prod', () => {
    expect(CONFIG).toMatch(
      /isProd\s*\?\s*`\$\{serialized\}; upgrade-insecure-requests`\s*:\s*serialized/,
    );
  });
});

describe('CSP header — operator-safety invariants', () => {
  it('reads origins from NEXT_PUBLIC_* env vars, not hardcoded hosts', () => {
    // Avoid baking "api.diktat.app" into the bundle; let the operator
    // flip environments without a code change.
    expect(CONFIG).toMatch(/process\.env\.NEXT_PUBLIC_SUPABASE_URL/);
    expect(CONFIG).toMatch(/process\.env\.NEXT_PUBLIC_API_URL/);
  });

  it('tolerates an unset SUPABASE_URL/API_URL at build time (safeHost returns "")', () => {
    // next build on Vercel runs before runtime env attaches on previews.
    // The policy must still assemble to a syntactically valid header.
    expect(CONFIG).toMatch(/function safeHost\(url\)\s*\{/);
    expect(CONFIG).toMatch(/catch\s*\{\s*return\s*''/);
  });
});
