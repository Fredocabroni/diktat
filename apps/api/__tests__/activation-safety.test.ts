import { describe, expect, it } from 'vitest';

import { checkJwtIssuer, requiresProductionGates } from '../src/activation-safety.js';
import { loadEnv, type Env } from '../src/env.js';

// ---------------------------------------------------------------------------
// Activation-safety gate — SUPABASE_JWT_ISSUER required in non-dev/test
// (#169 — PR #83 security-reviewer LOW).
//
// The gate must fire on any non-dev/test NODE_ENV. The exclusion-list
// posture mirrors the TRUSTED_PROXY_HOPS gate (see server.ts header
// comment) so that an enum widening to 'staging' / 'preview' would fail
// CLOSED on those values without a code change here.
// ---------------------------------------------------------------------------

// Minimal fixture — fields the predicate reads only.
function envFixture(overrides: Partial<Env>): Pick<Env, 'NODE_ENV' | 'SUPABASE_JWT_ISSUER'> {
  return {
    NODE_ENV: 'production',
    SUPABASE_JWT_ISSUER: 'https://test.supabase.co/auth/v1',
    ...overrides,
  };
}

describe('requiresProductionGates', () => {
  it('false in development', () => {
    expect(requiresProductionGates(envFixture({ NODE_ENV: 'development' }))).toBe(false);
  });

  it('false in test', () => {
    expect(requiresProductionGates(envFixture({ NODE_ENV: 'test' }))).toBe(false);
  });

  it('true in production', () => {
    expect(requiresProductionGates(envFixture({ NODE_ENV: 'production' }))).toBe(true);
  });

  it('fails CLOSED on an unknown NODE_ENV value (future enum widen)', () => {
    // The Zod enum rejects unknowns at parse time today, but if a future
    // widening adds 'staging' / 'preview', the gate must still fire. The
    // predicate's shape (exclusion list, not inclusion) is what gives us
    // that forward-compat.
    expect(
      requiresProductionGates({
        NODE_ENV: 'staging' as unknown as Env['NODE_ENV'],
      }),
    ).toBe(true);
  });
});

describe('checkJwtIssuer', () => {
  it('returns null in development even when SUPABASE_JWT_ISSUER is unset', () => {
    expect(
      checkJwtIssuer(envFixture({ NODE_ENV: 'development', SUPABASE_JWT_ISSUER: undefined })),
    ).toBeNull();
  });

  it('returns null in test even when SUPABASE_JWT_ISSUER is unset', () => {
    expect(
      checkJwtIssuer(envFixture({ NODE_ENV: 'test', SUPABASE_JWT_ISSUER: undefined })),
    ).toBeNull();
  });

  it('returns null in production when SUPABASE_JWT_ISSUER is set', () => {
    expect(
      checkJwtIssuer(
        envFixture({
          NODE_ENV: 'production',
          SUPABASE_JWT_ISSUER: 'https://real.supabase.co/auth/v1',
        }),
      ),
    ).toBeNull();
  });

  it('fails in production when SUPABASE_JWT_ISSUER is undefined', () => {
    const failure = checkJwtIssuer(
      envFixture({ NODE_ENV: 'production', SUPABASE_JWT_ISSUER: undefined }),
    );
    expect(failure).not.toBeNull();
    expect(failure?.reason).toBe('SUPABASE_JWT_ISSUER_unset_in_non_dev_test_env');
    expect(failure?.message).toMatch(/SUPABASE_JWT_ISSUER/);
    expect(failure?.message).toMatch(/iss/);
  });

  it('fails on an unknown NODE_ENV value with SUPABASE_JWT_ISSUER unset (forward-compat)', () => {
    const failure = checkJwtIssuer({
      NODE_ENV: 'staging' as unknown as Env['NODE_ENV'],
      SUPABASE_JWT_ISSUER: undefined,
    });
    expect(failure).not.toBeNull();
    expect(failure?.reason).toBe('SUPABASE_JWT_ISSUER_unset_in_non_dev_test_env');
  });

  it('failure.message names the Railway service for a legible crash', () => {
    // The console.error block in server.ts emits this message verbatim.
    // A deploy failure on a cold boot in Railway logs should tell the
    // operator exactly where to set the var — no scavenger hunt.
    const failure = checkJwtIssuer(
      envFixture({ NODE_ENV: 'production', SUPABASE_JWT_ISSUER: undefined }),
    );
    expect(failure?.message).toMatch(/Railway/i);
    expect(failure?.message).toMatch(/https:\/\/<project-ref>\.supabase\.co\/auth\/v1/);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: an empty-string Railway var must trip the boot gate.
//
// Threat model: a Railway dashboard operator who declares the variable
// but leaves its value blank. Without `loadEnv`'s `emptyToUndefined`
// coercion, '' would hit Zod's `.url().optional()` and fail boot at Zod
// — correct outcome but with a confusing error ("expected URL, got
// empty string") that doesn't name the activation gate. WITH the
// coercion, '' → undefined → passes `.optional()` → reaches
// `checkJwtIssuer`, which flags the real misconfiguration under its
// own structured `boot.activation_safety_failed` event. This test pins
// the entire chain so a future refactor that drops either half surfaces
// the regression here.
//
// Reviewer context: a security review on an earlier version of this PR
// raised an "empty-string bypass" concern; the end-to-end chain already
// handles it, this test proves it.
// ---------------------------------------------------------------------------

const PROD_BASE: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  TRUSTED_PROXY_HOPS: '1',
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'svc',
  SUPABASE_JWT_SECRET: 'jwt',
  UPSTASH_REDIS_REST_URL: 'https://u.upstash.io',
  UPSTASH_REDIS_REST_TOKEN: 't',
  WEB_ORIGINS: 'https://diktat-web1.vercel.app',
};

describe('end-to-end: empty-string SUPABASE_JWT_ISSUER trips the gate', () => {
  it('loadEnv coerces an empty-string SUPABASE_JWT_ISSUER to undefined, then checkJwtIssuer fires in production', () => {
    // Step 1: loadEnv does NOT throw on SUPABASE_JWT_ISSUER=''.
    // emptyToUndefined coerces before Zod's .url().optional() check, so
    // '' never reaches the url validator (which would otherwise throw).
    const env = loadEnv({ ...PROD_BASE, SUPABASE_JWT_ISSUER: '' });

    // Step 2: the coerced value is undefined — not an empty string.
    expect(env.SUPABASE_JWT_ISSUER).toBeUndefined();

    // Step 3: the activation gate sees undefined in production and
    // returns the structured failure, so server.ts exits 1 at boot.
    const failure = checkJwtIssuer(env);
    expect(failure).not.toBeNull();
    expect(failure?.reason).toBe('SUPABASE_JWT_ISSUER_unset_in_non_dev_test_env');
  });

  it('whitespace-only SUPABASE_JWT_ISSUER also trips the gate (keeps symmetry with other required vars)', () => {
    // emptyToUndefined's coercion today is `v === ''`, so a space-only
    // value falls through to Zod as a non-URL string and loadEnv
    // throws — which is also a loud boot failure, just at a different
    // layer. Either layer surfacing the misconfiguration is acceptable;
    // what matters is that boot never succeeds silently with a blank
    // issuer. This test documents the current layering so a future
    // widening of emptyToUndefined to include whitespace surfaces here
    // (gate takes over) rather than drifting behavior unnoticed.
    expect(() => loadEnv({ ...PROD_BASE, SUPABASE_JWT_ISSUER: '   ' })).toThrow(
      /SUPABASE_JWT_ISSUER/,
    );
  });

  it('a real SUPABASE_JWT_ISSUER URL in production passes the gate', () => {
    const env = loadEnv({
      ...PROD_BASE,
      SUPABASE_JWT_ISSUER: 'https://real.supabase.co/auth/v1',
    });
    expect(env.SUPABASE_JWT_ISSUER).toBe('https://real.supabase.co/auth/v1');
    expect(checkJwtIssuer(env)).toBeNull();
  });

  it('an empty SUPABASE_JWT_ISSUER in development does NOT fire the gate', () => {
    // Local dev often leaves the var blank; the gate is production-
    // only, so loadEnv + checkJwtIssuer must both no-op cleanly.
    const env = loadEnv({ ...PROD_BASE, NODE_ENV: 'development', SUPABASE_JWT_ISSUER: '' });
    expect(env.SUPABASE_JWT_ISSUER).toBeUndefined();
    expect(checkJwtIssuer(env)).toBeNull();
  });
});
