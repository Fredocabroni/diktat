// Perplexity Sonar adapter — unit tests.
//
// Scope: the adapter itself, in isolation. Fetch and sleep are
// dependency-injected so tests exercise the real retry/parse logic
// without a live network dependency.
//
// Covers the operator contract from the P4 batch:
//   - 1x retry on HTTP 429 after 2s pause (sleep mocked); third
//     response wins
//   - Two 429s in a row throw ProviderError (no infinite retry loop)
//   - Non-429 4xx/5xx throw immediately (no retry attempt)
//   - Missing PERPLEXITY_API_KEY throws RoutingError
//   - Structured output: parses the message.content JSON through
//     the Zod schema and returns the parsed data in `output`
//   - Non-JSON content on a 200 → ValidationError
//   - Schema mismatch → ValidationError with sanitised issues
//     (path + code, no received values)
//   - usd calculation includes the flat per-call search fee
//
// NOT covered here (handled by the orchestrator's integration
// tests): source_quality classification, authoritative derivation,
// HEAD-gate, dedup cache.

import { ProviderError, RoutingError, ValidationError } from '@diktat/shared';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { perplexityAdapter } from '../src/adapters/perplexity.js';
import type { ProviderEnv } from '../src/types.js';

const PROVIDER_ENV: ProviderEnv = {
  xaiAvailable: true,
  perplexityAvailable: true,
};

const TEST_SCHEMA = z.object({
  verdict: z.enum(['supported', 'refuted', 'mixed', 'unverifiable', 'contested']),
  reason: z.string(),
});

function buildOkResponse(
  content: string,
  usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
  },
): Response {
  const body = JSON.stringify({
    choices: [{ message: { role: 'assistant', content } }],
    usage: usage ?? { prompt_tokens: 100, completion_tokens: 200 },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

function build429Response(): Response {
  return new Response('{"error":"rate_limited"}', {
    status: 429,
    headers: { 'content-type': 'application/json' },
  });
}

const ORIGINAL_KEY = process.env.PERPLEXITY_API_KEY;

describe('perplexity adapter — operator contract', () => {
  beforeEach(() => {
    process.env.PERPLEXITY_API_KEY = 'test-key';
  });
  afterEach(() => {
    if (ORIGINAL_KEY === undefined) {
      delete process.env.PERPLEXITY_API_KEY;
    } else {
      process.env.PERPLEXITY_API_KEY = ORIGINAL_KEY;
    }
  });

  it("throws RoutingError when PERPLEXITY_API_KEY is missing (today's behaviour)", async () => {
    delete process.env.PERPLEXITY_API_KEY;
    const fetchImpl = vi.fn();
    await expect(
      perplexityAdapter.invoke({
        model: 'sonar',
        system: 's',
        user: 'u',
        env: PROVIDER_ENV,
        fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toBeInstanceOf(RoutingError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('happy path: parses structured output through the Zod schema', async () => {
    const okJson = JSON.stringify({ verdict: 'supported', reason: 'because' });
    const fetchImpl = vi.fn(async () =>
      buildOkResponse(okJson),
    ) as unknown as typeof globalThis.fetch;
    const result = await perplexityAdapter.invoke({
      model: 'sonar',
      system: 's',
      user: 'u',
      schema: TEST_SCHEMA,
      env: PROVIDER_ENV,
      fetchImpl,
    });
    expect(result.output).toEqual({ verdict: 'supported', reason: 'because' });
    // Flat search fee of $0.005 + 100 input tokens @ $1/M + 200 output
    // tokens @ $1/M = 0.005 + 0.0001 + 0.0002 = $0.0053.
    expect(result.usd).toBeCloseTo(0.0053, 4);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('retries exactly once on 429 after a 2s pause, then succeeds', async () => {
    const okJson = JSON.stringify({ verdict: 'refuted', reason: 'r' });
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return call === 1 ? build429Response() : buildOkResponse(okJson);
    }) as unknown as typeof globalThis.fetch;
    const sleep = vi.fn(async () => {});
    const result = await perplexityAdapter.invoke({
      model: 'sonar',
      system: 's',
      user: 'u',
      schema: TEST_SCHEMA,
      env: PROVIDER_ENV,
      fetchImpl,
      sleep,
    });
    expect(result.output).toEqual({ verdict: 'refuted', reason: 'r' });
    expect(call).toBe(2);
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('throws ProviderError on a second 429 — no infinite retry loop', async () => {
    const fetchImpl = vi.fn(async () => build429Response()) as unknown as typeof globalThis.fetch;
    const sleep = vi.fn(async () => {});
    await expect(
      perplexityAdapter.invoke({
        model: 'sonar',
        system: 's',
        user: 'u',
        schema: TEST_SCHEMA,
        env: PROVIDER_ENV,
        fetchImpl,
        sleep,
      }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // initial + 1 retry
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('throws ProviderError on a non-429 4xx without retrying', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('{"error":"forbidden"}', {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof globalThis.fetch;
    const sleep = vi.fn(async () => {});
    await expect(
      perplexityAdapter.invoke({
        model: 'sonar',
        system: 's',
        user: 'u',
        env: PROVIDER_ENV,
        fetchImpl,
        sleep,
      }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('throws ProviderError on a 5xx without retrying', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('{"error":"server"}', {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof globalThis.fetch;
    const sleep = vi.fn(async () => {});
    await expect(
      perplexityAdapter.invoke({
        model: 'sonar',
        system: 's',
        user: 'u',
        env: PROVIDER_ENV,
        fetchImpl,
        sleep,
      }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('throws ValidationError when 200 content is not JSON', async () => {
    const fetchImpl = vi.fn(async () =>
      buildOkResponse('this is not JSON'),
    ) as unknown as typeof globalThis.fetch;
    await expect(
      perplexityAdapter.invoke({
        model: 'sonar',
        system: 's',
        user: 'u',
        schema: TEST_SCHEMA,
        env: PROVIDER_ENV,
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws ValidationError with sanitised issues when the schema parse fails', async () => {
    // `verdict: 'bogus'` is not in the enum — Zod rejects.
    const bad = JSON.stringify({ verdict: 'bogus', reason: 'r' });
    const fetchImpl = vi.fn(async () => buildOkResponse(bad)) as unknown as typeof globalThis.fetch;
    try {
      await perplexityAdapter.invoke({
        model: 'sonar',
        system: 's',
        user: 'u',
        schema: TEST_SCHEMA,
        env: PROVIDER_ENV,
        fetchImpl,
      });
      throw new Error('expected ValidationError');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const cause = (err as ValidationError & { cause?: unknown }).cause as
        | { issues?: ReadonlyArray<{ path: string; code: string }> }
        | undefined;
      // Issues carry PATH + CODE only — never the received value (which
      // may echo prompt-injected content). Pins the M2 posture.
      expect(cause?.issues).toBeDefined();
      for (const issue of cause!.issues!) {
        expect(issue).toHaveProperty('path');
        expect(issue).toHaveProperty('code');
        expect(issue).not.toHaveProperty('received');
      }
    }
  });

  it('sends model=sonar and the API-key bearer header', async () => {
    const okJson = JSON.stringify({ verdict: 'supported', reason: 'r' });
    let capturedUrl = '';
    let capturedBody = '';
    let capturedAuth = '';
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedBody = init.body as string;
      capturedAuth =
        (init.headers as Record<string, string>).authorization ??
        (init.headers as Record<string, string>).Authorization ??
        '';
      return buildOkResponse(okJson);
    }) as unknown as typeof globalThis.fetch;
    await perplexityAdapter.invoke({
      model: 'sonar',
      system: 's',
      user: 'u',
      schema: TEST_SCHEMA,
      env: PROVIDER_ENV,
      fetchImpl,
    });
    expect(capturedUrl).toBe('https://api.perplexity.ai/chat/completions');
    expect(capturedAuth).toBe('Bearer test-key');
    const body = JSON.parse(capturedBody) as { model: string; response_format?: unknown };
    expect(body.model).toBe('sonar');
    expect(body.response_format).toBeDefined();
  });
});
