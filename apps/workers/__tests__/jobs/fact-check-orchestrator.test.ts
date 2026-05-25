import { describe, expect, it } from 'vitest';

import { factCheckOrchestratorHandler } from '../../src/jobs/fact-check-orchestrator.js';
import type { ScheduledJobRow } from '../../src/jobs/scheduler.js';
import type { Logger } from '../../src/logger.js';
import type { ServiceClient } from '../../src/supabase.js';

const CLAIM_ID = 'cd66f3e0-aaaa-4aaa-aaaa-aaaaaaaaaaaa';

function row(partial: Partial<ScheduledJobRow> = {}): ScheduledJobRow {
  return {
    id: partial.id ?? 'fc-1',
    job_type: partial.job_type ?? 'fact_check',
    idempotency_key: partial.idempotency_key ?? CLAIM_ID,
    target_user_id: null,
    payload: partial.payload ?? { claim_id: CLAIM_ID },
    status: 'processing',
    attempts: 1,
    max_attempts: 5,
    available_at: new Date().toISOString(),
    locked_at: new Date().toISOString(),
    locked_by: 'workers-test',
    last_error: null,
    processed_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}
interface UpdateCall {
  table: string;
  patch: Record<string, unknown>;
  whereId: string;
}
interface FakeState {
  rpcCalls: RpcCall[];
  rpcResults: Map<string, { data: unknown; error: { message: string } | null }>;
  selects: Array<{ table: string; whereId: string; result: unknown }>;
  updates: UpdateCall[];
  updateError: { message: string } | null;
}

function buildSupabase(state: FakeState, claimRow: unknown = null): ServiceClient {
  return {
    rpc: (fn: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args });
      const r = state.rpcResults.get(fn) ?? { data: null, error: null };
      return Promise.resolve(r);
    },
    from: (table: string) => ({
      select: (_cols: string) => ({
        eq: (_col: string, val: unknown) => ({
          maybeSingle: () => {
            state.selects.push({ table, whereId: String(val), result: claimRow });
            return Promise.resolve({ data: claimRow, error: null });
          },
        }),
      }),
      update: (patch: Record<string, unknown>) => ({
        eq: (_col: string, id: unknown) => {
          state.updates.push({ table, patch, whereId: String(id) });
          return Promise.resolve({ error: state.updateError });
        },
      }),
    }),
  } as unknown as ServiceClient;
}

function buildLogger(): Logger & { calls: { level: string; obj: Record<string, unknown> }[] } {
  const calls: { level: string; obj: Record<string, unknown> }[] = [];
  const push = (level: string) => (obj: Record<string, unknown>) => calls.push({ level, obj });
  return {
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    debug: push('debug'),
    calls,
  };
}

function fakeInvoke(opts: {
  verdict: string;
  confidence?: number;
  reason?: string;
  contestedReason?: string | null;
  sources?: Array<{ url: string; label: string; snippet: string | null }>;
  provider?: 'anthropic' | 'perplexity';
  model?: string;
  usd?: number;
}): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (_req: any) =>
    ({
      output: {
        verdict: opts.verdict,
        confidence: opts.confidence ?? 0.8,
        reason: opts.reason ?? 'fixture',
        contested_reason: opts.contestedReason ?? null,
        sources: opts.sources ?? [
          {
            url: 'https://www.congress.gov/bill/118th-congress/house-bill/7521',
            label: 'PAFACA',
            snippet: null,
          },
        ],
      },
      provider: opts.provider ?? 'anthropic',
      model: opts.model ?? 'claude-sonnet-4-6',
      usd: opts.usd ?? 0.003,
      latencyMs: 1200,
      task: 'sourced_factcheck',
    }) as never;
}

const FAKE_FETCH = (() =>
  Promise.resolve({
    status: 200,
  } as Response)) as unknown as typeof globalThis.fetch;

const PROVIDER_ENV = { xaiAvailable: false, perplexityAvailable: false };

describe('factCheckOrchestratorHandler', () => {
  it('throws when invoke/providerEnv/fetch are missing in deps (boot-wiring regression guard)', async () => {
    const state: FakeState = {
      rpcCalls: [],
      rpcResults: new Map(),
      selects: [],
      updates: [],
      updateError: null,
    };
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    await expect(factCheckOrchestratorHandler(row(), { supabase, logger })).rejects.toThrow(
      /requires invoke \+ providerEnv \+ fetch/,
    );
  });

  it('throws when payload.claim_id is missing', async () => {
    const state: FakeState = {
      rpcCalls: [],
      rpcResults: new Map(),
      selects: [],
      updates: [],
      updateError: null,
    };
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    await expect(
      factCheckOrchestratorHandler(row({ payload: {} }), {
        supabase,
        logger,
        invoke: fakeInvoke({ verdict: 'supported' }) as never,
        providerEnv: PROVIDER_ENV,
        fetch: FAKE_FETCH,
      }),
    ).rejects.toThrow(/payload.claim_id is required/);
  });

  it('cache_hit: dedup returns hit, handler short-circuits without invoking fabric', async () => {
    const state: FakeState = {
      rpcCalls: [],
      rpcResults: new Map([
        ['fact_check_dedup_lookup', { data: { hit: true, verdict: { id: 'v1' } }, error: null }],
      ]),
      selects: [],
      updates: [],
      updateError: null,
    };
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    let invokeCount = 0;
    const trackingInvoke = (async () => {
      invokeCount += 1;
      return { output: {} } as never;
    }) as unknown as never;
    await factCheckOrchestratorHandler(row(), {
      supabase,
      logger,
      invoke: trackingInvoke,
      providerEnv: PROVIDER_ENV,
      fetch: FAKE_FETCH,
    });
    expect(invokeCount).toBe(0);
    expect(state.rpcCalls).toEqual([
      { fn: 'fact_check_dedup_lookup', args: { p_claim_id: CLAIM_ID } },
    ]);
    expect(state.updates).toHaveLength(1);
    const patch = state.updates[0]?.patch as { payload: Record<string, unknown> };
    expect(patch.payload.outcome).toBe('cache_hit');
    expect(logger.calls.find((c) => c.obj.event === 'fact_check.cache_hit')).toBeDefined();
  });

  it('claim_missing: claim row deleted between enqueue and dispatch — marks done, no fabric call', async () => {
    const state: FakeState = {
      rpcCalls: [],
      rpcResults: new Map([['fact_check_dedup_lookup', { data: { hit: false }, error: null }]]),
      selects: [],
      updates: [],
      updateError: null,
    };
    const supabase = buildSupabase(state, null); // claim row not found
    const logger = buildLogger();
    let invokeCount = 0;
    const trackingInvoke = (async () => {
      invokeCount += 1;
      return { output: {} } as never;
    }) as unknown as never;
    await factCheckOrchestratorHandler(row(), {
      supabase,
      logger,
      invoke: trackingInvoke,
      providerEnv: PROVIDER_ENV,
      fetch: FAKE_FETCH,
    });
    expect(invokeCount).toBe(0);
    const patch = state.updates[0]?.patch as { payload: Record<string, unknown> };
    expect(patch.payload.outcome).toBe('claim_missing');
    expect(logger.calls.find((c) => c.obj.event === 'fact_check.claim_missing')).toBeDefined();
  });

  it.each(['supported', 'refuted', 'mixed', 'unverifiable'] as const)(
    'happy path: invokes fabric, persists verdict and sources (%s)',
    async (verdictValue) => {
      const verdictId = 'v-fixture';
      const state: FakeState = {
        rpcCalls: [],
        rpcResults: new Map([
          ['fact_check_dedup_lookup', { data: { hit: false }, error: null }],
          ['fact_check_persist_verdict', { data: verdictId, error: null }],
        ]),
        selects: [],
        updates: [],
        updateError: null,
      };
      const supabase = buildSupabase(state, {
        id: CLAIM_ID,
        claim_text: 'A claim about a thing.',
        claim_context: 'ctx',
      });
      const logger = buildLogger();
      await factCheckOrchestratorHandler(row(), {
        supabase,
        logger,
        invoke: fakeInvoke({ verdict: verdictValue }) as never,
        providerEnv: PROVIDER_ENV,
        fetch: FAKE_FETCH,
      });
      const persistCall = state.rpcCalls.find((c) => c.fn === 'fact_check_persist_verdict');
      expect(persistCall).toBeDefined();
      const persistArgs = persistCall!.args as {
        p_claim_id: string;
        p_verdict: { verdict: string; route: string; retrieval_mode: string; model: string };
        p_sources: Array<{ url: string; fetch_status: string; position: number }>;
      };
      expect(persistArgs.p_claim_id).toBe(CLAIM_ID);
      expect(persistArgs.p_verdict.verdict).toBe(verdictValue);
      expect(persistArgs.p_verdict.route).toBe('sourced_factcheck');
      expect(persistArgs.p_verdict.retrieval_mode).toBe('none');
      expect(persistArgs.p_sources).toHaveLength(1);
      expect(persistArgs.p_sources[0]?.fetch_status).toBe('skipped'); // congress.gov is whitelisted
      const stamp = state.updates.find((u) => u.table === 'scheduled_jobs');
      const patch = stamp!.patch as { payload: Record<string, unknown> };
      expect(patch.payload.outcome).toBe('verdict_recorded');
      expect(patch.payload.verdict_id).toBe(verdictId);
      expect(patch.payload.retrieval_mode).toBe('none');
    },
  );

  it('contested: requires contested_reason; Zod refine accepts when present', async () => {
    const verdictId = 'v-contested';
    const state: FakeState = {
      rpcCalls: [],
      rpcResults: new Map([
        ['fact_check_dedup_lookup', { data: { hit: false }, error: null }],
        ['fact_check_persist_verdict', { data: verdictId, error: null }],
      ]),
      selects: [],
      updates: [],
      updateError: null,
    };
    const supabase = buildSupabase(state, {
      id: CLAIM_ID,
      claim_text: 'Policy X is better than policy Y.',
      claim_context: '',
    });
    const logger = buildLogger();
    await factCheckOrchestratorHandler(row(), {
      supabase,
      logger,
      invoke: fakeInvoke({
        verdict: 'contested',
        contestedReason: 'Value-laden — disagreement on goal weights.',
      }) as never,
      providerEnv: PROVIDER_ENV,
      fetch: FAKE_FETCH,
    });
    const persistArgs = state.rpcCalls.find((c) => c.fn === 'fact_check_persist_verdict')!.args as {
      p_verdict: { verdict: string; contested_reason: string };
    };
    expect(persistArgs.p_verdict.verdict).toBe('contested');
    expect(persistArgs.p_verdict.contested_reason).toMatch(/Value-laden/);
  });

  it('retrieval_mode stamps "perplexity" when fabric routes to perplexity', async () => {
    const state: FakeState = {
      rpcCalls: [],
      rpcResults: new Map([
        ['fact_check_dedup_lookup', { data: { hit: false }, error: null }],
        ['fact_check_persist_verdict', { data: 'v', error: null }],
      ]),
      selects: [],
      updates: [],
      updateError: null,
    };
    const supabase = buildSupabase(state, {
      id: CLAIM_ID,
      claim_text: 'A claim about a thing.',
      claim_context: '',
    });
    const logger = buildLogger();
    await factCheckOrchestratorHandler(row(), {
      supabase,
      logger,
      invoke: fakeInvoke({
        verdict: 'supported',
        provider: 'perplexity',
        model: 'sonar-large-online',
      }) as never,
      providerEnv: { xaiAvailable: false, perplexityAvailable: true },
      fetch: FAKE_FETCH,
    });
    const persistArgs = state.rpcCalls.find((c) => c.fn === 'fact_check_persist_verdict')!.args as {
      p_verdict: { retrieval_mode: string; model: string };
    };
    expect(persistArgs.p_verdict.retrieval_mode).toBe('perplexity');
    expect(persistArgs.p_verdict.model).toBe('sonar-large-online');
  });

  it('dedup RPC error → throws so the scheduler retries with backoff', async () => {
    const state: FakeState = {
      rpcCalls: [],
      rpcResults: new Map([
        ['fact_check_dedup_lookup', { data: null, error: { message: 'sql: timeout' } }],
      ]),
      selects: [],
      updates: [],
      updateError: null,
    };
    const supabase = buildSupabase(state);
    const logger = buildLogger();
    await expect(
      factCheckOrchestratorHandler(row(), {
        supabase,
        logger,
        invoke: fakeInvoke({ verdict: 'supported' }) as never,
        providerEnv: PROVIDER_ENV,
        fetch: FAKE_FETCH,
      }),
    ).rejects.toThrow(/fact_check_dedup_lookup RPC failed.*timeout/);
  });

  it('persist RPC error → throws (re-attempt will cache-hit; verdict is durable)', async () => {
    const state: FakeState = {
      rpcCalls: [],
      rpcResults: new Map([
        ['fact_check_dedup_lookup', { data: { hit: false }, error: null }],
        ['fact_check_persist_verdict', { data: null, error: { message: 'permission denied' } }],
      ]),
      selects: [],
      updates: [],
      updateError: null,
    };
    const supabase = buildSupabase(state, {
      id: CLAIM_ID,
      claim_text: 'A claim about a thing.',
      claim_context: '',
    });
    const logger = buildLogger();
    await expect(
      factCheckOrchestratorHandler(row(), {
        supabase,
        logger,
        invoke: fakeInvoke({ verdict: 'supported' }) as never,
        providerEnv: PROVIDER_ENV,
        fetch: FAKE_FETCH,
      }),
    ).rejects.toThrow(/fact_check_persist_verdict RPC failed.*permission denied/);
  });
});
