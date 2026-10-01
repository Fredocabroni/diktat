// Activation-safety gate predicates.
//
// Each predicate inspects the loaded env and either returns `null` (no
// problem) or an `ActivationFailure` describing why boot should abort.
// server.ts wires the predicates into a hard-exit block that fires
// before Fastify is constructed, so a misconfigured deploy crashes loud
// at startup instead of silently running under a weaker security
// posture.
//
// Scope boundary: these checks are the "production must declare X"
// family. They mirror the shape of the TRUSTED_PROXY_HOPS gate that
// lives inline in server.ts; new checks are added here (not inline)
// so each gate can be unit-tested without booting Fastify.
//
// NODE_ENV classification: a check fires when NODE_ENV is anything
// OTHER than 'development' or 'test' (so production today, AND any
// future staging/preview value if the Zod enum is later widened).
// Inverting to an exclusion list means the production-safe path is the
// default and unknown environments fail CLOSED. This matches the
// posture of the TRUSTED_PROXY_HOPS gate in server.ts; see PR #78
// round-2 security-reviewer MED #1 for the original rationale.

import type { Env } from './env.js';

export interface ActivationFailure {
  readonly reason: string;
  readonly message: string;
}

/**
 * True when the loaded env represents a non-dev/test environment and
 * therefore must declare the "production must declare X" invariants.
 */
export function requiresProductionGates(env: Pick<Env, 'NODE_ENV'>): boolean {
  return env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test';
}

/**
 * Require `SUPABASE_JWT_ISSUER` in non-dev/test. When unset, `jose`'s
 * `jwtVerify` in `context.ts` does not check the `iss` claim — a token
 * signed with the same `SUPABASE_JWT_SECRET` by a different Supabase
 * project would be accepted as valid. "Someone remembered to set the
 * env var" is not a defense; this boot gate is.
 *
 * Returns `null` on pass. Returns an `ActivationFailure` on fail with
 * `reason` suitable for log structured search and a human-readable
 * `message` for the boot-crash console.
 */
export function checkJwtIssuer(
  env: Pick<Env, 'NODE_ENV' | 'SUPABASE_JWT_ISSUER'>,
): ActivationFailure | null {
  if (!requiresProductionGates(env)) return null;
  if (env.SUPABASE_JWT_ISSUER !== undefined) return null;
  return {
    reason: 'SUPABASE_JWT_ISSUER_unset_in_non_dev_test_env',
    message:
      `Refusing to start: NODE_ENV='${env.NODE_ENV}' is not a local dev/test ` +
      'environment and requires SUPABASE_JWT_ISSUER to be set. Without it, ' +
      "jose's jwtVerify does not check the `iss` claim — a token signed with " +
      'the same SUPABASE_JWT_SECRET by a different Supabase project would be ' +
      'accepted as valid. Set SUPABASE_JWT_ISSUER on the Railway diktat-api ' +
      'service to `https://<project-ref>.supabase.co/auth/v1`.',
  };
}
