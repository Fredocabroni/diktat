// Stateless JWT verifier for Supabase-issued tokens. Used by `apps/api` to
// authenticate incoming tRPC requests without round-tripping to Supabase.
//
// Supabase signs JWTs with the project's HS256 JWT secret (Settings → API).
// The verifier requires:
//   - the secret (raw string),
//   - optional issuer (defaults to permissive — pass for stricter checks),
//   - optional audience (defaults to 'authenticated', the role Supabase
//     stamps on signed-in user JWTs).
//
// All failure modes throw `ValidationError` with a message a caller can log
// safely. Never echo the token itself to the user.

import { jwtVerify, errors as joseErrors } from 'jose';

import { ValidationError } from '@diktat/shared';

export interface VerifiedClaims {
  readonly sub: string;
  readonly email?: string;
  readonly role: string;
  readonly exp: number;
}

export interface VerifyJwtOptions {
  /** Supabase project JWT secret. Required. */
  readonly secret: string;
  /** Strict issuer check, e.g. `https://<ref>.supabase.co/auth/v1`. Optional. */
  readonly issuer?: string;
  /** JWT `aud` claim — Supabase signed-in users carry `'authenticated'`. */
  readonly audience?: string;
}

/**
 * Verify a Supabase JWT. Returns the canonical claims on success; throws
 * `ValidationError` on every failure mode (expired, malformed, wrong sig,
 * wrong issuer/audience, missing `sub`).
 */
export async function verifyJwt(
  token: string,
  opts: VerifyJwtOptions,
): Promise<VerifiedClaims> {
  if (!opts.secret) {
    throw new ValidationError('verifyJwt: missing JWT secret');
  }
  if (!token || typeof token !== 'string') {
    throw new ValidationError('verifyJwt: token must be a non-empty string');
  }

  const key = new TextEncoder().encode(opts.secret);

  let payload: Awaited<ReturnType<typeof jwtVerify>>['payload'];
  try {
    const result = await jwtVerify(token, key, {
      algorithms: ['HS256'],
      ...(opts.issuer ? { issuer: opts.issuer } : {}),
      audience: opts.audience ?? 'authenticated',
    });
    payload = result.payload;
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      throw new ValidationError('verifyJwt: token expired', err);
    }
    if (err instanceof joseErrors.JWTClaimValidationFailed) {
      throw new ValidationError(`verifyJwt: claim invalid (${err.claim})`, err);
    }
    if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
      throw new ValidationError('verifyJwt: signature mismatch', err);
    }
    if (err instanceof joseErrors.JOSEError) {
      throw new ValidationError(`verifyJwt: ${err.code}`, err);
    }
    throw new ValidationError('verifyJwt: verification failed', err);
  }

  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new ValidationError('verifyJwt: missing or empty sub claim');
  }
  if (typeof payload.exp !== 'number') {
    throw new ValidationError('verifyJwt: missing exp claim');
  }

  return {
    sub: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    role: typeof payload.role === 'string' ? payload.role : 'anon',
    exp: payload.exp,
  };
}
