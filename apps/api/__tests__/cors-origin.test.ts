import { describe, expect, it } from 'vitest';

import { decideCorsOrigin } from '../src/cors-origin.js';

// ---------------------------------------------------------------------------
// CORS `origin` callback decision — #168 (PR #82 round-1 reviewer MED).
//
// Three-way split: absent-header pass (server-to-server), literal
// `Origin: null` deny (browser opaque-origin contexts), allow-list
// check otherwise. See `src/cors-origin.ts` for the reasoning behind
// each case.
// ---------------------------------------------------------------------------

const ALLOW_LIST: readonly string[] = ['https://diktat-web1.vercel.app', 'https://diktat.app'];

describe('decideCorsOrigin', () => {
  it('absent header (undefined) → allow — server-to-server callers (Railway healthcheck, operator curl)', () => {
    expect(decideCorsOrigin(undefined, ALLOW_LIST)).toEqual({ allowed: true });
  });

  it('literal "null" string → deny — browser opaque-origin contexts (file://, sandboxed iframes)', () => {
    // Per Fetch spec browsers send Origin: null from file:// pages and
    // sandboxed iframes with the opaque-origin bit set. @fastify/cors
    // with allowed=false omits Access-Control-Allow-Origin; the browser
    // then blocks the response.
    expect(decideCorsOrigin('null', ALLOW_LIST)).toEqual({ allowed: false });
  });

  it('allow-listed origin → allow', () => {
    expect(decideCorsOrigin('https://diktat-web1.vercel.app', ALLOW_LIST)).toEqual({
      allowed: true,
    });
    expect(decideCorsOrigin('https://diktat.app', ALLOW_LIST)).toEqual({ allowed: true });
  });

  it('non-allow-listed origin → deny', () => {
    expect(decideCorsOrigin('https://evil.example', ALLOW_LIST)).toEqual({ allowed: false });
    expect(decideCorsOrigin('https://attacker.diktat.app.evil', ALLOW_LIST)).toEqual({
      allowed: false,
    });
  });

  it('empty-string origin → deny (not a legitimate Origin shape; absent header is undefined, not "")', () => {
    // A truly absent header surfaces as `undefined` through Node's
    // headers API, not `''`. If some caller sends `Origin: ` with no
    // value, we treat it as a shape bug and deny — allow-list check
    // against an empty allow-list membership is false.
    expect(decideCorsOrigin('', ALLOW_LIST)).toEqual({ allowed: false });
  });

  it('case variants of "null" ("NULL", "Null") → deny via allow-list check (browsers canonicalize to lowercase)', () => {
    // Browsers emit `null` lowercase per the Fetch spec, so case
    // variants fall into the allow-list branch rather than the literal-
    // null branch. They deny there too (unless some caller has put
    // `'Null'` into WEB_ORIGINS, which would be a shape bug).
    expect(decideCorsOrigin('NULL', ALLOW_LIST)).toEqual({ allowed: false });
    expect(decideCorsOrigin('Null', ALLOW_LIST)).toEqual({ allowed: false });
  });

  it('absent origin with an empty allow-list → allow — WEB_ORIGINS can decouple from the CORS handler', () => {
    // Guards the invariant surfaced by PR #162 round-3 security
    // reviewer: if the boot gate and this helper are ever decoupled
    // (e.g. a future deploy that empties WEB_ORIGINS without the gate
    // firing), server-to-server callers (Railway healthcheck, operator
    // curl, future webhooks) must still pass. The early-return on
    // `undefined` makes this obviously correct by code inspection; the
    // test pins it so a future refactor that collapses the branches
    // can't silently flip the behavior.
    expect(decideCorsOrigin(undefined, [])).toEqual({ allowed: true });
  });
});
