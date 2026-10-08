// Activation-safety gate: WEB_ORIGINS production assertion.
//
// `env.WEB_ORIGINS` defaults to `http://localhost:3000`. If an operator
// forgets to set the var on the Railway diktat-api service when
// deploying, the CORS allow-list silently rejects every real production
// origin — the API fails-closed from a security standpoint, but the
// symptom in the browser is "nothing works" rather than "the deploy is
// misconfigured." A production deploy whose observable symptom is
// "nothing works" is a launch-day timebomb.
//
// This gate refuses to boot the API in non-dev/test when
// `WEB_ORIGINS` contains ONLY localhost-shaped origins (or is empty).
// At least one non-localhost origin must be declared.
//
// NODE_ENV classification uses the same exclusion-list posture as the
// existing TRUSTED_PROXY_HOPS gate in server.ts (!== 'development' &&
// !== 'test'), not strict `=== 'production'`, so a future enum widening
// to 'staging' / 'preview' fails CLOSED on those values without a code
// change here. See PR #78 round-2 security-reviewer MED #1 for the
// rationale on the existing gate; this gate copies that posture
// deliberately.
//
// Localhost shapes considered "not a real production origin":
//   - hostname === 'localhost' (case-insensitive)
//   - hostname === '127.0.0.1'
//   - hostname === '0.0.0.0'
//   - hostname === '::1' / '[::1]' (IPv6 loopback with or without URL brackets)
//
// A WEB_ORIGINS entry that fails `new URL(...)` parsing is treated as a
// non-localhost origin so this gate does not stack on top of a shape
// problem the env parser should surface instead.

import type { Env } from './env.js';

export interface WebOriginsActivationFailure {
  readonly reason: 'WEB_ORIGINS_contains_only_localhost_in_non_dev_test_env';
  readonly message: string;
}

function requiresProductionGates(env: Pick<Env, 'NODE_ENV'>): boolean {
  return env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test';
}

export function isLocalhostOrigin(origin: string): boolean {
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'localhost') return true;
  if (host === '127.0.0.1') return true;
  if (host === '0.0.0.0') return true;
  // IPv6 loopback — accept both the bracketed and bare forms.
  // Current WHATWG-compliant runtimes (Node ≥ ~14, modern browsers)
  // return `[::1]` from `URL.hostname` for `http://[::1]/`. The bare
  // `::1` branch guards against older or non-standard runtimes that
  // strip the brackets (and against callers that pass the hostname
  // directly rather than via a URL). PRs #172 and #162 security
  // reviewers both flagged one of these as unreachable; verified in
  // the test suite that `[::1]` is the firing branch under current
  // Node, so retaining both branches is defensive, not dead code.
  if (host === '::1') return true;
  if (host === '[::1]') return true;
  return false;
}

export function hasOnlyLocalhostOrigins(origins: readonly string[]): boolean {
  if (origins.length === 0) return true;
  return origins.every(isLocalhostOrigin);
}

export function checkWebOrigins(
  env: Pick<Env, 'NODE_ENV' | 'WEB_ORIGINS'>,
): WebOriginsActivationFailure | null {
  if (!requiresProductionGates(env)) return null;
  if (!hasOnlyLocalhostOrigins(env.WEB_ORIGINS)) return null;
  return {
    reason: 'WEB_ORIGINS_contains_only_localhost_in_non_dev_test_env',
    message:
      `Refusing to start: NODE_ENV='${env.NODE_ENV}' is not a local dev/test ` +
      'environment and WEB_ORIGINS declares only localhost-shaped origins ' +
      '(or is empty). The CORS allow-list would reject every real client. ' +
      'Set WEB_ORIGINS on the Railway diktat-api service to a comma-separated ' +
      'list of production origins (e.g. `https://diktat-web1.vercel.app`, ' +
      'plus preview domains if applicable).',
  };
}
