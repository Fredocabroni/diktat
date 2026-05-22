// Stateless JWT verifier for Supabase-issued tokens. Used by `apps/api` to
// authenticate incoming tRPC requests without round-tripping to Supabase.
//
// Supports HS256 (legacy shared-secret) and ES256/RS256/EdDSA (asymmetric,
// via JWKS). Pick one of `secret` or `jwksUrl` per call. Modern Supabase
// projects sign with asymmetric keys and expose JWKS at
// `<projectUrl>/auth/v1/.well-known/jwks.json`.

import { jwtVerify, errors as joseErrors, createRemoteJWKSet } from 'jose';

import { ValidationError } from '@diktat/shared';

export interface VerifiedClaims {
  readonly sub: string;
  readonly email?: string;
  readonly role: string;
  readonly exp: number;
}

export interface VerifyJwtOptions {
  /** HS256 shared secret. Mutually exclusive with `jwksUrl`. */
  readonly secret?: string;
  /** Asymmetric JWKS endpoint URL. Mutually exclusive with `secret`. */
  readonly jwksUrl?: string;
  /** Strict issuer check, e.g. `https://<ref>.supabase.co/auth/v1`. Optional. */
  readonly issuer?: string;
  /** JWT `aud` claim — Supabase signed-in users carry `'authenticated'`. */
  readonly audience?: string;
}

// Cache JWKS sets per URL so we don't refetch on every request.
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(url: string): ReturnType<typeof createRemoteJWKSet> {
  let jwks = jwksCache.get(url);
  if (jwks === undefined) {
    jwks = createRemoteJWKSet(new URL(url));
    jwksCache.set(url, jwks);
  }
  return jwks;
}

export async function verifyJwt(
  token: string,
  opts: VerifyJwtOptions,
): Promise<VerifiedClaims> {
  if (!token || typeof token !== 'string') {
    throw new ValidationError('verifyJwt: token must be a non-empty string');
  }
  if (!opts.secret && !opts.jwksUrl) {
    throw new ValidationError('verifyJwt: must supply either secret or jwksUrl');
  }

  const baseOpts = {
    ...(opts.issuer ? { issuer: opts.issuer } : {}),
    audience: opts.audience ?? 'authenticated',
  };

  let payload: Awaited<ReturnType<typeof jwtVerify>>['payload'];
  try {
    if (opts.jwksUrl) {
      const jwks = getJwks(opts.jwksUrl);
      const result = await jwtVerify(token, jwks, {
        algorithms: ['ES256', 'RS256', 'EdDSA'],
        ...baseOpts,
      });
      payload = result.payload;
    } else {
      const key = new TextEncoder().encode(opts.secret as string);
      const result = await jwtVerify(token, key, {
        algorithms: ['HS256'],
        ...baseOpts,
      });
      payload = result.payload;
    }
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
