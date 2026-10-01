import { describe, expect, it } from 'vitest';

import {
  evaluateOriginGate,
  NO_ORIGIN_ALLOWED_PATHS,
  ORIGIN_GATE_REJECTED_BODY,
} from '../src/origin-gate.js';

// ---------------------------------------------------------------------------
// Origin-presence gate (#168 — PR #82 security-reviewer MED).
//
// Browser-facing routes require an `Origin` header. The gate's job is to
// short-circuit requests without one — except for the exact-match
// allowlist of server-to-server endpoints (currently `/health`).
// ---------------------------------------------------------------------------

describe('evaluateOriginGate', () => {
  describe('browser-facing routes (/trpc/*)', () => {
    it('rejects a /trpc call with no Origin header', () => {
      const d = evaluateOriginGate({ url: '/trpc/user.me', originHeader: undefined });
      expect(d).toEqual({ reject: true, reason: 'missing_origin' });
    });

    it('rejects a /trpc call with an empty-string Origin header', () => {
      const d = evaluateOriginGate({ url: '/trpc/user.me', originHeader: '' });
      expect(d).toEqual({ reject: true, reason: 'missing_origin' });
    });

    it('rejects a /trpc call with a whitespace-only Origin header', () => {
      // A trimmed empty value should be indistinguishable from missing.
      const d = evaluateOriginGate({ url: '/trpc/user.me', originHeader: '   ' });
      expect(d).toEqual({ reject: true, reason: 'missing_origin' });
    });

    it('passes a /trpc call that carries a real Origin', () => {
      const d = evaluateOriginGate({
        url: '/trpc/user.me',
        originHeader: 'https://diktat-web1.vercel.app',
      });
      expect(d).toEqual({ reject: false });
    });

    it('passes nested /trpc paths with Origin', () => {
      const d = evaluateOriginGate({
        url: '/trpc/wallet.transactions?batch=1',
        originHeader: 'https://diktat-web1.vercel.app',
      });
      expect(d).toEqual({ reject: false });
    });

    it('rejects /trpc paths with a querystring and no Origin', () => {
      // Querystring strip must happen before the exempt-path check, but
      // not reclassify the path. `/trpc/foo?x=1` is still /trpc.
      const d = evaluateOriginGate({ url: '/trpc/foo?batch=1', originHeader: undefined });
      expect(d).toEqual({ reject: true, reason: 'missing_origin' });
    });
  });

  describe('exempt paths (NO_ORIGIN_ALLOWED_PATHS)', () => {
    it('exempts GET /health with no Origin (Railway liveness probe)', () => {
      const d = evaluateOriginGate({ url: '/health', originHeader: undefined });
      expect(d).toEqual({ reject: false });
    });

    it('exempts GET /health?probe=1 with no Origin (strips query before match)', () => {
      // The outer-hook exemption applies the same strip-querystring
      // normalization; this gate must mirror it so a probe decorated
      // with a cache-buster still passes.
      const d = evaluateOriginGate({ url: '/health?probe=1', originHeader: undefined });
      expect(d).toEqual({ reject: false });
    });

    it('exempts GET /health even if it DOES carry an Origin', () => {
      // Health probes aren't browser-sourced, but if some operator curls
      // /health from a browser dev console, Origin would be set. Still
      // treat the path as exempt — the gate is about path classification,
      // not Origin presence on exempt paths.
      const d = evaluateOriginGate({
        url: '/health',
        originHeader: 'https://diktat-web1.vercel.app',
      });
      expect(d).toEqual({ reject: false });
    });

    it('does NOT exempt a path that merely starts with /health (e.g. /healthz)', () => {
      // Exact-match exemption only, same posture as OUTER_HOOK_EXEMPT_PATHS.
      // A probe hitting `/healthFAKE` or `/healthz` must still require Origin.
      const d = evaluateOriginGate({ url: '/healthz', originHeader: undefined });
      expect(d).toEqual({ reject: true, reason: 'missing_origin' });
    });

    it('does NOT exempt /health/../../etc (defense against path tricks)', () => {
      // Fastify's router would 404 this path, but the gate must not
      // consume the exemption. Match the outer-hook posture.
      const d = evaluateOriginGate({ url: '/health/../../etc', originHeader: undefined });
      expect(d).toEqual({ reject: true, reason: 'missing_origin' });
    });

    it('allowlist is exactly {`/health`}', () => {
      // Guard against a future quiet addition. If this test needs an
      // update, the new path must be justified in origin-gate.ts's
      // header comment AND surfaced in the PR body.
      expect([...NO_ORIGIN_ALLOWED_PATHS].sort()).toEqual(['/health']);
    });
  });

  describe('response body', () => {
    it('ORIGIN_GATE_REJECTED_BODY shape is frozen and public-contract-stable', () => {
      expect(ORIGIN_GATE_REJECTED_BODY).toEqual({
        error: 'origin_required',
        message: 'This endpoint requires an Origin header.',
      });
    });

    it('body does NOT leak the exempt-path allowlist (403 oracle hardening)', () => {
      // A 403 that lists allowed paths lets a probe enumerate the
      // allowlist with one request. Keep the body shape path-free.
      const serialized = JSON.stringify(ORIGIN_GATE_REJECTED_BODY);
      expect(serialized).not.toContain('/health');
      expect(serialized).not.toContain('path');
      expect(serialized).not.toContain('allowlist');
    });
  });

  describe('unexpected / adversarial inputs', () => {
    it('empty url string rejects (unknown path, no Origin → fail-closed)', () => {
      const d = evaluateOriginGate({ url: '', originHeader: undefined });
      expect(d).toEqual({ reject: true, reason: 'missing_origin' });
    });

    it('url with only a query string rejects (not /health)', () => {
      const d = evaluateOriginGate({ url: '?x=1', originHeader: undefined });
      expect(d).toEqual({ reject: true, reason: 'missing_origin' });
    });
  });
});
