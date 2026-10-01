import { describe, expect, it } from 'vitest';

import type { Env } from '../src/env.js';
import {
  checkWebOrigins,
  hasOnlyLocalhostOrigins,
  isLocalhostOrigin,
} from '../src/web-origins-gate.js';

// ---------------------------------------------------------------------------
// Activation-safety gate — WEB_ORIGINS production assertion
// (#170 — PR #83 security-reviewer LOW).
//
// Fires in non-dev/test when WEB_ORIGINS declares only localhost-shaped
// origins (or is empty). The CORS allow-list would otherwise reject
// every real client and the symptom in the browser is "nothing works"
// rather than "deploy is misconfigured" — a launch-day timebomb.
// ---------------------------------------------------------------------------

function envFixture(overrides: Partial<Env>): Pick<Env, 'NODE_ENV' | 'WEB_ORIGINS'> {
  return {
    NODE_ENV: 'production',
    WEB_ORIGINS: ['https://diktat-web1.vercel.app'],
    ...overrides,
  };
}

describe('isLocalhostOrigin', () => {
  it('http://localhost:3000 → true', () => {
    expect(isLocalhostOrigin('http://localhost:3000')).toBe(true);
  });

  it('http://localhost (no port) → true', () => {
    expect(isLocalhostOrigin('http://localhost')).toBe(true);
  });

  it('https://LOCALHOST:3000 case-insensitive → true', () => {
    expect(isLocalhostOrigin('https://LOCALHOST:3000')).toBe(true);
  });

  it('http://127.0.0.1:8080 → true', () => {
    expect(isLocalhostOrigin('http://127.0.0.1:8080')).toBe(true);
  });

  it('http://0.0.0.0:3000 → true', () => {
    expect(isLocalhostOrigin('http://0.0.0.0:3000')).toBe(true);
  });

  it('http://[::1]:3000 (IPv6 loopback) → true', () => {
    expect(isLocalhostOrigin('http://[::1]:3000')).toBe(true);
  });

  it('https://diktat-web1.vercel.app → false (real production origin)', () => {
    expect(isLocalhostOrigin('https://diktat-web1.vercel.app')).toBe(false);
  });

  it('https://diktat.app → false (real production origin)', () => {
    expect(isLocalhostOrigin('https://diktat.app')).toBe(false);
  });

  it('http://localhost.evil.com → false (not actually localhost)', () => {
    // Hostname-match posture: a lookalike domain whose label contains
    // "localhost" must NOT be treated as loopback. `new URL().hostname`
    // for this is `localhost.evil.com` which does not equal `localhost`.
    expect(isLocalhostOrigin('http://localhost.evil.com')).toBe(false);
  });

  it('http://127.0.0.2 → false (loopback /8 but not literal 127.0.0.1)', () => {
    // We intentionally match literal strings, not the full 127.0.0.0/8
    // loopback range. Anything other than the three canonical loopback
    // literals is treated as non-localhost; a real production environment
    // declaring 127.0.0.2 is nonsensical and the gate correctly passes
    // (lets boot proceed) so the operator can see the oddity in the log.
    expect(isLocalhostOrigin('http://127.0.0.2')).toBe(false);
  });

  it('garbage string that fails new URL() → false (fail-safe)', () => {
    // If garbage made it into WEB_ORIGINS, the gate should NOT stack on
    // top of a shape problem the env parser should surface. Treat
    // unparseable entries as non-localhost so boot proceeds; a bad shape
    // becomes a visible CORS misconfiguration rather than a boot crash.
    expect(isLocalhostOrigin('not a url')).toBe(false);
    expect(isLocalhostOrigin('')).toBe(false);
  });
});

describe('hasOnlyLocalhostOrigins', () => {
  it('empty array → true (no non-localhost origin)', () => {
    expect(hasOnlyLocalhostOrigins([])).toBe(true);
  });

  it('["http://localhost:3000"] → true', () => {
    expect(hasOnlyLocalhostOrigins(['http://localhost:3000'])).toBe(true);
  });

  it('mixed localhost shapes → true', () => {
    expect(
      hasOnlyLocalhostOrigins(['http://localhost:3000', 'http://127.0.0.1', 'http://[::1]:4000']),
    ).toBe(true);
  });

  it('localhost + one real origin → false (at least one non-localhost)', () => {
    expect(
      hasOnlyLocalhostOrigins(['http://localhost:3000', 'https://diktat-web1.vercel.app']),
    ).toBe(false);
  });

  it('one real origin only → false', () => {
    expect(hasOnlyLocalhostOrigins(['https://diktat.app'])).toBe(false);
  });
});

describe('checkWebOrigins', () => {
  it('returns null in development even with only localhost origins', () => {
    expect(
      checkWebOrigins(
        envFixture({ NODE_ENV: 'development', WEB_ORIGINS: ['http://localhost:3000'] }),
      ),
    ).toBeNull();
  });

  it('returns null in test even with only localhost origins', () => {
    expect(
      checkWebOrigins(envFixture({ NODE_ENV: 'test', WEB_ORIGINS: ['http://localhost:3000'] })),
    ).toBeNull();
  });

  it('returns null in production when a real origin is declared', () => {
    expect(
      checkWebOrigins(
        envFixture({ NODE_ENV: 'production', WEB_ORIGINS: ['https://diktat-web1.vercel.app'] }),
      ),
    ).toBeNull();
  });

  it('returns null in production when real + localhost are both declared', () => {
    // Common case: production includes a localhost origin for a dev
    // tunnel. As long as at least one real origin exists, pass.
    expect(
      checkWebOrigins(
        envFixture({
          NODE_ENV: 'production',
          WEB_ORIGINS: ['http://localhost:3000', 'https://diktat-web1.vercel.app'],
        }),
      ),
    ).toBeNull();
  });

  it('fails in production when WEB_ORIGINS contains only localhost', () => {
    const failure = checkWebOrigins(
      envFixture({ NODE_ENV: 'production', WEB_ORIGINS: ['http://localhost:3000'] }),
    );
    expect(failure).not.toBeNull();
    expect(failure?.reason).toBe('WEB_ORIGINS_contains_only_localhost_in_non_dev_test_env');
    expect(failure?.message).toMatch(/WEB_ORIGINS/);
    expect(failure?.message).toMatch(/CORS/);
  });

  it('fails in production when WEB_ORIGINS is empty', () => {
    const failure = checkWebOrigins(envFixture({ NODE_ENV: 'production', WEB_ORIGINS: [] }));
    expect(failure).not.toBeNull();
    expect(failure?.reason).toBe('WEB_ORIGINS_contains_only_localhost_in_non_dev_test_env');
  });

  it('fails on an unknown NODE_ENV (forward-compat exclusion-list)', () => {
    // Mirrors the TRUSTED_PROXY_HOPS gate posture: an enum widen to
    // 'staging' / 'preview' must still fire this check.
    const failure = checkWebOrigins({
      NODE_ENV: 'staging' as unknown as Env['NODE_ENV'],
      WEB_ORIGINS: ['http://localhost:3000'],
    });
    expect(failure).not.toBeNull();
    expect(failure?.reason).toBe('WEB_ORIGINS_contains_only_localhost_in_non_dev_test_env');
  });

  it('failure.message names the Railway service for a legible crash', () => {
    const failure = checkWebOrigins(
      envFixture({ NODE_ENV: 'production', WEB_ORIGINS: ['http://localhost:3000'] }),
    );
    expect(failure?.message).toMatch(/Railway/i);
    expect(failure?.message).toMatch(/diktat-web1\.vercel\.app/);
  });
});
