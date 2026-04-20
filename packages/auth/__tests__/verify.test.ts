import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';

import { ValidationError } from '@diktat/shared';

import { verifyJwt } from '../src/verify.js';

const SECRET = 'super-secret-jwt-key-for-tests-only';
const ISSUER = 'https://test.supabase.co/auth/v1';
const SUB = 'cd1f3c4a-7d3a-4f8c-bf12-1f7d5d111aaa';

async function sign(claims: Record<string, unknown>, expSeconds = 3600): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const key = new TextEncoder().encode(SECRET);
  const builder = new SignJWT({ ...claims, role: claims.role ?? 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject((claims.sub as string | undefined) ?? SUB)
    .setIssuedAt(now)
    .setExpirationTime(now + expSeconds)
    .setIssuer(ISSUER)
    .setAudience('authenticated');
  return builder.sign(key);
}

describe('verifyJwt', () => {
  it('returns canonical claims for a well-formed Supabase JWT', async () => {
    const token = await sign({ email: 'voter@diktat.test' });
    const claims = await verifyJwt(token, { secret: SECRET, issuer: ISSUER });

    expect(claims.sub).toBe(SUB);
    expect(claims.email).toBe('voter@diktat.test');
    expect(claims.role).toBe('authenticated');
    expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('omits email when the JWT carries no email claim', async () => {
    const token = await sign({});
    const claims = await verifyJwt(token, { secret: SECRET, issuer: ISSUER });
    expect(claims.email).toBeUndefined();
  });

  it('throws ValidationError when the secret is wrong', async () => {
    const token = await sign({});
    await expect(
      verifyJwt(token, { secret: 'a-completely-different-secret', issuer: ISSUER }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws ValidationError when the token is expired', async () => {
    const token = await sign({}, -60);
    await expect(verifyJwt(token, { secret: SECRET, issuer: ISSUER })).rejects.toMatchObject({
      message: expect.stringContaining('expired'),
    });
  });

  it('throws ValidationError when the issuer does not match', async () => {
    const token = await sign({});
    await expect(
      verifyJwt(token, { secret: SECRET, issuer: 'https://other.supabase.co/auth/v1' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws ValidationError when the audience does not match', async () => {
    const token = await sign({});
    await expect(
      verifyJwt(token, { secret: SECRET, issuer: ISSUER, audience: 'service_role' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws ValidationError on malformed token', async () => {
    await expect(verifyJwt('not.a.jwt', { secret: SECRET })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('rejects empty token strings', async () => {
    await expect(verifyJwt('', { secret: SECRET })).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects calls without a secret', async () => {
    const token = await sign({});
    await expect(verifyJwt(token, { secret: '' })).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects tokens with no sub claim', async () => {
    const now = Math.floor(Date.now() / 1000);
    const key = new TextEncoder().encode(SECRET);
    const token = await new SignJWT({ role: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .sign(key);
    await expect(verifyJwt(token, { secret: SECRET, issuer: ISSUER })).rejects.toMatchObject({
      message: expect.stringContaining('sub'),
    });
  });
});
