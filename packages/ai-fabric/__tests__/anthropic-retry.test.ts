// Pins the Anthropic adapter's bounded safeParse-failure retry
// (CLAUDE.md "Deferred / Known issues" — one retry on schema parse
// failure, cumulative USD on throw).
//
// The adapter calls Anthropic().messages.create() through a lazy
// singleton; we vi.mock the SDK module itself to intercept every
// call. One attempt per `mockResponse` entry; the test queues two
// bad-shape responses to force the retry path to exhaust and
// throw.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const createMock = vi.fn<(args: unknown) => Promise<unknown>>();

vi.mock('@anthropic-ai/sdk', () => {
  class Anthropic {
    public messages: { create: typeof createMock };
    constructor(_opts: unknown) {
      this.messages = { create: createMock };
    }
  }
  return { default: Anthropic };
});

const Schema = z.object({ title: z.string(), count: z.number().int() });

function toolUseResponse(input: unknown) {
  return {
    content: [{ type: 'tool_use', input }],
    usage: { input_tokens: 10, output_tokens: 5 },
    stop_reason: 'end_turn',
  };
}

describe('anthropic adapter — bounded retry on schema_parse failure', () => {
  beforeEach(() => {
    createMock.mockReset();
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });
  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('retries once on schema_parse failure; returns success on retry', async () => {
    // First call returns a bad shape (count missing); second returns valid.
    createMock
      .mockResolvedValueOnce(toolUseResponse({ title: 'ok' })) // missing count
      .mockResolvedValueOnce(toolUseResponse({ title: 'ok', count: 7 }));

    const { anthropicAdapter } = await import('../src/adapters/anthropic.js');
    const out = await anthropicAdapter.invoke({
      model: 'claude-sonnet-4-6',
      system: 'sys',
      user: 'user',
      schema: Schema,
      env: { xaiAvailable: false, perplexityAvailable: false },
    });
    expect(out.output).toEqual({ title: 'ok', count: 7 });
    // Both attempts were billed.
    expect(createMock).toHaveBeenCalledTimes(2);
    // Cumulative spend is 2x the single-call price.
    expect(out.usd).toBeGreaterThan(0);
  });

  it('throws after MAX_STRUCTURED_ATTEMPTS=2 with cumulative USD stamped', async () => {
    // Both attempts return a bad shape.
    createMock
      .mockResolvedValueOnce(toolUseResponse({ title: 'ok' }))
      .mockResolvedValueOnce(toolUseResponse({ title: 42 }));

    const { anthropicAdapter } = await import('../src/adapters/anthropic.js');
    await expect(
      anthropicAdapter.invoke({
        model: 'claude-sonnet-4-6',
        system: 'sys',
        user: 'user',
        schema: Schema,
        env: { xaiAvailable: false, perplexityAvailable: false },
      }),
    ).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof Error)) return false;
      if (!/after 2 attempts/.test(err.message)) return false;
      // billedUsd stamped on the error by stampBilledUsd — accumulated
      // across both attempts.
      const billed = (err as { billedUsd?: number }).billedUsd;
      return typeof billed === 'number' && billed > 0;
    });
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry when the response lacks a tool_use block (not transient)', async () => {
    // Response has no tool_use — a structural prompt/API problem,
    // not a parse flake. Should throw after one attempt.
    createMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'oops' }],
      usage: { input_tokens: 10, output_tokens: 5 },
      stop_reason: 'end_turn',
    });

    const { anthropicAdapter } = await import('../src/adapters/anthropic.js');
    await expect(
      anthropicAdapter.invoke({
        model: 'claude-sonnet-4-6',
        system: 'sys',
        user: 'user',
        schema: Schema,
        env: { xaiAvailable: false, perplexityAvailable: false },
      }),
    ).rejects.toThrow(/expected tool_use block/);
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});
