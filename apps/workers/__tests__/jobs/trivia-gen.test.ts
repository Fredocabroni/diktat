import { describe, expect, it, vi } from 'vitest';

import { runTriviaGen } from '../../src/jobs/trivia-gen.js';
import type { Logger } from '../../src/logger.js';
import type { ServiceClient } from '../../src/supabase.js';

interface InsertCall {
  payload: Record<string, unknown>;
}

interface FakeSupabase {
  client: ServiceClient;
  inserts: InsertCall[];
  insertResult: { error: { message: string } | null };
}

function buildSupabase(opts: { insertResult?: FakeSupabase['insertResult'] } = {}): FakeSupabase {
  const state: FakeSupabase = {
    client: null as unknown as ServiceClient,
    inserts: [],
    insertResult: opts.insertResult ?? { error: null },
  };

  const fromImpl = (table: string) => {
    if (table !== 'trivia_questions') {
      throw new Error(`fakeSupabase: unexpected table ${table}`);
    }
    return {
      insert(payload: Record<string, unknown>) {
        state.inserts.push({ payload });
        return {
          select(_cols: string) {
            return {
              maybeSingle: async () => ({ data: { id: 'inserted' }, ...state.insertResult }),
            };
          },
        };
      },
    };
  };

  state.client = { from: fromImpl } as unknown as ServiceClient;
  return state;
}

function buildLogger(): Logger & { calls: { level: string; obj: object }[] } {
  const calls: { level: string; obj: object }[] = [];
  const push = (level: string) => (obj: object) => {
    calls.push({ level, obj });
  };
  return {
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    debug: push('debug'),
    calls,
  };
}

const SAMPLE_DRAFT = {
  prompt: 'Which agency publishes the monthly Consumer Price Index release?',
  choices: ['Treasury', 'Federal Reserve', 'BLS', 'OMB'],
  correct_index: 2,
  difficulty: 4,
  // govtrack.us is intentionally NOT in trivia-gen's HEAD_CHECK_WHITELIST, so
  // the HEAD probe actually runs — the 'HEAD fails' test depends on that.
  source_url: 'https://www.govtrack.us/',
  source_label: 'GovTrack',
};

const SAMPLE_DRAFT_2 = {
  prompt: 'How many U.S. senators are required to invoke cloture?',
  choices: ['51', '60', '67', '75'],
  correct_index: 1,
  difficulty: 3,
  source_url: 'https://www.congress.gov/',
  source_label: 'Congress.gov',
};

// www.bls.gov IS in trivia-gen's HEAD_CHECK_WHITELIST — its HEAD probe is
// skipped, so verification proceeds even when the probe would have failed.
const WHITELISTED_DRAFT = {
  prompt: 'Which agency publishes the monthly Consumer Price Index release?',
  choices: ['Treasury', 'Federal Reserve', 'BLS', 'OMB'],
  correct_index: 2,
  difficulty: 4,
  source_url: 'https://www.bls.gov/cpi/',
  source_label: 'Bureau of Labor Statistics',
};

function buildFetch(headStatus: number): typeof globalThis.fetch {
  return vi.fn(
    async () => new Response(null, { status: headStatus }),
  ) as unknown as typeof globalThis.fetch;
}

describe('runTriviaGen', () => {
  it('writes verified rows when generator + verifier agree and HEAD is 200', async () => {
    const supabase = buildSupabase();
    const logger = buildLogger();
    const invoke = vi.fn();
    invoke.mockResolvedValueOnce({
      output: { questions: [SAMPLE_DRAFT, SAMPLE_DRAFT_2] },
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      task: 'trivia_gen',
      usd: 0.012,
      latencyMs: 800,
    });
    invoke.mockResolvedValueOnce({
      output: { agrees: true, confidence: 0.92, reason: 'cite confirms' },
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      task: 'sourced_factcheck',
      usd: 0.004,
      latencyMs: 600,
    });
    invoke.mockResolvedValueOnce({
      output: { agrees: true, confidence: 0.88, reason: 'rule 22 confirms' },
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      task: 'sourced_factcheck',
      usd: 0.004,
      latencyMs: 600,
    });

    const result = await runTriviaGen(
      { category: 'congress', count: 2, difficultyBand: [1, 5] },
      {
        invoke: invoke as never,
        supabase: supabase.client,
        logger,
        fetch: buildFetch(200),
      },
    );

    expect(result).toEqual({ generated: 2, verified: 2, rejected: 0, failed: 0 });
    expect(supabase.inserts).toHaveLength(2);
    expect(supabase.inserts[0]!.payload).toMatchObject({
      category: 'congress',
      verified: true,
      verified_by_user_id: null,
      correct_index: 2,
    });
  });

  it('rejects (verified=false) when the source URL HEAD fails', async () => {
    const supabase = buildSupabase();
    const logger = buildLogger();
    const invoke = vi.fn();
    invoke.mockResolvedValueOnce({
      output: { questions: [SAMPLE_DRAFT] },
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      task: 'trivia_gen',
      usd: 0.005,
      latencyMs: 800,
    });

    const result = await runTriviaGen(
      { category: 'fed', count: 1, difficultyBand: [3, 5] },
      {
        invoke: invoke as never,
        supabase: supabase.client,
        logger,
        fetch: buildFetch(404),
      },
    );

    expect(result).toEqual({ generated: 1, verified: 0, rejected: 1, failed: 0 });
    expect(supabase.inserts).toHaveLength(1);
    expect(supabase.inserts[0]!.payload).toMatchObject({ verified: false });
    // Verifier should not be called when HEAD fails.
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('skips the HEAD check for whitelisted hosts and still verifies', async () => {
    const supabase = buildSupabase();
    const logger = buildLogger();
    const invoke = vi.fn();
    invoke.mockResolvedValueOnce({
      output: { questions: [WHITELISTED_DRAFT] },
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      task: 'trivia_gen',
      usd: 0.005,
      latencyMs: 800,
    });
    invoke.mockResolvedValueOnce({
      output: { agrees: true, confidence: 0.91, reason: 'cite confirms' },
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      task: 'sourced_factcheck',
      usd: 0.004,
      latencyMs: 600,
    });

    // HEAD would 404 if probed — a whitelisted host must skip the probe.
    const fetchMock = buildFetch(404);
    const result = await runTriviaGen(
      { category: 'fed', count: 1, difficultyBand: [3, 5] },
      {
        invoke: invoke as never,
        supabase: supabase.client,
        logger,
        fetch: fetchMock,
      },
    );

    expect(result).toEqual({ generated: 1, verified: 1, rejected: 0, failed: 0 });
    expect(supabase.inserts[0]!.payload).toMatchObject({ verified: true });
    // Generator + verifier both run; the HEAD probe is skipped, not performed.
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      logger.calls.find(
        (c) => (c.obj as { event?: string }).event === 'trivia.gen.head_skipped_whitelist',
      ),
    ).toBeDefined();
  });

  it('rejects (verified=false) when verifier disagrees', async () => {
    const supabase = buildSupabase();
    const logger = buildLogger();
    const invoke = vi.fn();
    invoke.mockResolvedValueOnce({
      output: { questions: [SAMPLE_DRAFT] },
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      task: 'trivia_gen',
      usd: 0.005,
      latencyMs: 800,
    });
    invoke.mockResolvedValueOnce({
      output: { agrees: false, confidence: 0.95, reason: 'cite mismatch' },
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      task: 'sourced_factcheck',
      usd: 0.004,
      latencyMs: 600,
    });

    const result = await runTriviaGen(
      { category: 'fed', count: 1, difficultyBand: [3, 5] },
      {
        invoke: invoke as never,
        supabase: supabase.client,
        logger,
        fetch: buildFetch(200),
      },
    );

    expect(result).toEqual({ generated: 1, verified: 0, rejected: 1, failed: 0 });
    expect(supabase.inserts[0]!.payload).toMatchObject({ verified: false });
  });

  it('rejects (verified=false) when verifier confidence is below the floor', async () => {
    const supabase = buildSupabase();
    const logger = buildLogger();
    const invoke = vi.fn();
    invoke.mockResolvedValueOnce({
      output: { questions: [SAMPLE_DRAFT] },
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      task: 'trivia_gen',
      usd: 0.005,
      latencyMs: 800,
    });
    invoke.mockResolvedValueOnce({
      output: { agrees: true, confidence: 0.5, reason: 'ambiguous' },
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      task: 'sourced_factcheck',
      usd: 0.004,
      latencyMs: 600,
    });

    const result = await runTriviaGen(
      { category: 'fed', count: 1, difficultyBand: [3, 5] },
      {
        invoke: invoke as never,
        supabase: supabase.client,
        logger,
        fetch: buildFetch(200),
      },
    );

    expect(result).toEqual({ generated: 1, verified: 0, rejected: 1, failed: 0 });
    expect(supabase.inserts[0]!.payload).toMatchObject({ verified: false });
  });

  it('returns all-failed when the generator throws (no inserts)', async () => {
    const supabase = buildSupabase();
    const logger = buildLogger();
    const invoke = vi.fn().mockRejectedValueOnce(new Error('budget cap'));

    const result = await runTriviaGen(
      { category: 'fed', count: 5, difficultyBand: [3, 5] },
      {
        invoke: invoke as never,
        supabase: supabase.client,
        logger,
        fetch: buildFetch(200),
      },
    );

    expect(result).toEqual({ generated: 0, verified: 0, rejected: 0, failed: 5 });
    expect(supabase.inserts).toHaveLength(0);
    expect(
      logger.calls.find(
        (c) =>
          c.level === 'error' &&
          (c.obj as { event: string }).event === 'trivia.gen.generator_failed',
      ),
    ).toBeDefined();
  });

  it('counts insert failures separately from rejections', async () => {
    const supabase = buildSupabase({ insertResult: { error: { message: 'pg down' } } });
    const logger = buildLogger();
    const invoke = vi.fn();
    invoke.mockResolvedValueOnce({
      output: { questions: [SAMPLE_DRAFT] },
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      task: 'trivia_gen',
      usd: 0.005,
      latencyMs: 800,
    });
    invoke.mockResolvedValueOnce({
      output: { agrees: true, confidence: 0.9, reason: 'ok' },
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      task: 'sourced_factcheck',
      usd: 0.004,
      latencyMs: 600,
    });

    const result = await runTriviaGen(
      { category: 'fed', count: 1, difficultyBand: [3, 5] },
      {
        invoke: invoke as never,
        supabase: supabase.client,
        logger,
        fetch: buildFetch(200),
      },
    );

    expect(result).toEqual({ generated: 1, verified: 0, rejected: 0, failed: 1 });
  });
});
