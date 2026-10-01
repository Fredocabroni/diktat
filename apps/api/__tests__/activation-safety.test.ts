import { describe, expect, it } from 'vitest';

import { checkJwtIssuer, requiresProductionGates } from '../src/activation-safety.js';
import type { Env } from '../src/env.js';

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
