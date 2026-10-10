import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';

import { appRouter } from '../../src/routers/index.js';
import { fakeDb, makeCtx } from '../helpers.js';

const TOPIC_ID = '11111111-1111-1111-1111-111111111111';
const CLIENT_KEY_A = 'cccccccc-1111-4111-8111-cccccccccccc';

// #145 PR B: recordShift now routes through the record_opinion_shift
// RPC. The resolver no longer does a pre-SELECT for before_position or
// a 23505 fallback SELECT — both of those live in the SQL function. The
// test fake exposes only `.rpc()`, which captures the function name
// and args per call and returns a canned result.
type RpcResult = {
  data: Record<string, unknown> | null;
  error: { code?: string; message?: string } | null;
};
interface RpcCall {
  readonly fn: string;
  readonly args: Record<string, unknown>;
}
function rpcFake(results: RpcResult[]): { db: { rpc: unknown; from: unknown }; calls: RpcCall[] } {
  const calls: RpcCall[] = [];
  let cursor = 0;
  const rpc = (fn: string, args: Record<string, unknown>): Promise<RpcResult> => {
    calls.push({ fn, args });
    const r = results[cursor] ?? { data: null, error: null };
    cursor += 1;
    return Promise.resolve(r);
  };
  // `.from()` should never be reached for recordShift post-swap; wire a
  // trap that makes the test fail loudly if someone accidentally
  // reintroduces a direct-INSERT path.
  const from = (t: string) => {
    throw new Error(`rpcFake: unexpected .from('${t}') — recordShift must only call .rpc()`);
  };
  return { db: { rpc, from }, calls };
}

describe('feedRouter.recordShift', () => {
  const INSERTED_ROW = {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    topic_id: TOPIC_ID,
    before_position: 0,
    after_position: 1,
    created_at: '2026-04-25T00:00:00.000Z',
  };

  it('calls record_opinion_shift with the input topic / after_position / client_key', async () => {
    const { db, calls } = rpcFake([{ data: INSERTED_ROW, error: null }]);
    const caller = appRouter.createCaller(makeCtx({ db }));

    const result = await caller.feed.recordShift({
      topicId: TOPIC_ID,
      afterPosition: 1,
      clientKey: CLIENT_KEY_A,
    });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.fn).toBe('record_opinion_shift');
    expect(call.args).toEqual({
      p_topic_id: TOPIC_ID,
      p_after_position: 1,
      p_client_key: CLIENT_KEY_A,
    });

    expect(result).toEqual({
      id: INSERTED_ROW.id,
      topicId: INSERTED_ROW.topic_id,
      beforePosition: 0,
      afterPosition: 1,
      createdAt: INSERTED_ROW.created_at,
    });
  });

  it('omits p_client_key when the input omits clientKey (legacy PWA path — SQL default NULL applies)', async () => {
    // After the types-regen the generated .rpc() overload declares
    // `p_client_key?: string` (optional UUID, not nullable), so the
    // resolver passes `undefined` to opt out. The Supabase RPC call
    // then sends the args without that key, and the SQL function's
    // `p_client_key uuid default null` default kicks in — identical
    // DB-side outcome to the pre-regen `null`-literal behavior.
    const { db, calls } = rpcFake([{ data: INSERTED_ROW, error: null }]);
    const caller = appRouter.createCaller(makeCtx({ db }));

    await caller.feed.recordShift({
      topicId: TOPIC_ID,
      afterPosition: 1,
      // clientKey omitted
    });

    expect(calls).toHaveLength(1);
    // Either `undefined` (post-regen) or `null` (pre-regen) is correct:
    // both route to SQL NULL at the DB. Pin the invariant without
    // over-constraining the TS shape.
    expect(calls[0]!.args.p_client_key).toBeFalsy();
  });

  it('idempotent retry: same clientKey returns the SAME row — the RPC resolved the conflict server-side', async () => {
    // The RPC's ON CONFLICT (user_id, client_key) WHERE client_key IS
    // NOT NULL DO NOTHING path returns the pre-existing row. The
    // resolver sees exactly the same shape as a first-time insert
    // (freshly inserted vs. idempotent retry are indistinguishable at
    // this layer, which is the whole point).
    const EXISTING_ROW = { ...INSERTED_ROW, before_position: 0, after_position: 1 };
    const { db, calls } = rpcFake([
      { data: EXISTING_ROW, error: null }, // first call: inserts
      { data: EXISTING_ROW, error: null }, // retry: returns same row via RPC
    ]);
    const caller = appRouter.createCaller(makeCtx({ db }));

    const first = await caller.feed.recordShift({
      topicId: TOPIC_ID,
      afterPosition: 1,
      clientKey: CLIENT_KEY_A,
    });
    const retry = await caller.feed.recordShift({
      topicId: TOPIC_ID,
      afterPosition: 1,
      clientKey: CLIENT_KEY_A,
    });

    expect(retry.id).toBe(first.id);
    expect(retry).toEqual(first);
    // Both calls hit the RPC with the same client_key.
    expect(calls).toHaveLength(2);
    expect(calls[0]!.args.p_client_key).toBe(CLIENT_KEY_A);
    expect(calls[1]!.args.p_client_key).toBe(CLIENT_KEY_A);
  });

  it('P0002 → NOT_FOUND (topic does not exist)', async () => {
    const { db } = rpcFake([{ data: null, error: { code: 'P0002', message: 'topic not found' } }]);
    const caller = appRouter.createCaller(makeCtx({ db }));

    await expect(
      caller.feed.recordShift({
        topicId: TOPIC_ID,
        afterPosition: 1,
        clientKey: CLIENT_KEY_A,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('54000 → TOO_MANY_REQUESTS (rolling-24h cap) — NEVER an INTERNAL_SERVER_ERROR 500', async () => {
    // Architect requirement for PR B: cap breach must surface as a
    // clean tRPC error, not a generic 500. A client reading `code`
    // should see TOO_MANY_REQUESTS and know this is retryable later.
    const { db } = rpcFake([
      { data: null, error: { code: '54000', message: 'rate limit exceeded' } },
    ]);
    const caller = appRouter.createCaller(makeCtx({ db }));

    await expect(
      caller.feed.recordShift({
        topicId: TOPIC_ID,
        afterPosition: 1,
        clientKey: CLIENT_KEY_A,
      }),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });

  it('22023 → BAD_REQUEST (RPC-level out-of-range check — defence in depth over the Zod gate)', async () => {
    // The Zod positionSchema already filters -2..2 at the input
    // boundary. The RPC's own range check fires only on a bypass path
    // (future resolver change that drops the Zod guard, or a direct
    // RPC call from a service_role caller). Map it to BAD_REQUEST so
    // the error class carries intent even if the trip source changes.
    const { db } = rpcFake([
      { data: null, error: { code: '22023', message: 'after_position out of range' } },
    ]);
    const caller = appRouter.createCaller(makeCtx({ db }));

    await expect(
      caller.feed.recordShift({
        topicId: TOPIC_ID,
        afterPosition: 1,
        clientKey: CLIENT_KEY_A,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('28000 → UNAUTHORIZED (RPC auth.uid() check — unreachable from protectedProcedure, defence in depth)', async () => {
    const { db } = rpcFake([
      { data: null, error: { code: '28000', message: 'not authenticated' } },
    ]);
    const caller = appRouter.createCaller(makeCtx({ db }));

    await expect(
      caller.feed.recordShift({
        topicId: TOPIC_ID,
        afterPosition: 1,
        clientKey: CLIENT_KEY_A,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('unknown SQLSTATE → INTERNAL_SERVER_ERROR with sanitized cause (no raw PostgrestError on the wire)', async () => {
    const { db } = rpcFake([
      // Simulate an unexpected DB error — e.g. a lock-timeout, serialization
      // failure, or an injected code the RPC does not model.
      { data: null, error: { code: '40P01', message: 'deadlock detected' } },
    ]);
    const caller = appRouter.createCaller(makeCtx({ db }));

    await expect(
      caller.feed.recordShift({
        topicId: TOPIC_ID,
        afterPosition: 1,
        clientKey: CLIENT_KEY_A,
      }),
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });

  it('null RPC result with no error → INTERNAL_SERVER_ERROR (never fabricates a success)', async () => {
    const { db } = rpcFake([{ data: null, error: null }]);
    const caller = appRouter.createCaller(makeCtx({ db }));

    await expect(
      caller.feed.recordShift({
        topicId: TOPIC_ID,
        afterPosition: 1,
        clientKey: CLIENT_KEY_A,
      }),
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });

  it('rejects out-of-range positions at Zod — never reaches the RPC', async () => {
    const { db, calls } = rpcFake([]);
    const caller = appRouter.createCaller(makeCtx({ db }));

    await expect(
      caller.feed.recordShift({
        topicId: TOPIC_ID,
        afterPosition: 3 as 0 | 1 | 2,
        clientKey: CLIENT_KEY_A,
      }),
    ).rejects.toBeInstanceOf(TRPCError);
    expect(calls).toEqual([]);
  });

  it('rejects a non-uuid topicId at Zod — never reaches the RPC', async () => {
    const { db, calls } = rpcFake([]);
    const caller = appRouter.createCaller(makeCtx({ db }));

    await expect(
      caller.feed.recordShift({
        topicId: 'not-a-uuid',
        afterPosition: 0,
        clientKey: CLIENT_KEY_A,
      }),
    ).rejects.toBeInstanceOf(TRPCError);
    expect(calls).toEqual([]);
  });

  it('rejects a present-but-non-uuid clientKey at Zod — never reaches the RPC', async () => {
    const { db, calls } = rpcFake([]);
    const caller = appRouter.createCaller(makeCtx({ db }));

    await expect(
      caller.feed.recordShift({
        topicId: TOPIC_ID,
        afterPosition: 1,
        clientKey: 'not-a-uuid',
      }),
    ).rejects.toBeInstanceOf(TRPCError);
    expect(calls).toEqual([]);
  });

  it('does NOT call .from() — the direct-INSERT path is retired', async () => {
    // Regression guard against a future refactor that re-adds a
    // pre-SELECT or a fallback SELECT via `.from('opinion_shifts')`.
    // The rpcFake's .from() throws, so any such call fails this test
    // loudly before any assertion.
    const { db } = rpcFake([{ data: INSERTED_ROW, error: null }]);
    const caller = appRouter.createCaller(makeCtx({ db }));

    await expect(
      caller.feed.recordShift({
        topicId: TOPIC_ID,
        afterPosition: 1,
        clientKey: CLIENT_KEY_A,
      }),
    ).resolves.toBeDefined();
  });
});

describe('feedRouter.list', () => {
  const DROP_ROW = {
    id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    headline: 'Senate votes 52-48 on the CR',
    source_title: 'Senate passes FY27 continuing resolution',
    summary: 'Cloture filed Monday; final passage Thursday after a week of amendments.',
    primary_source_url: 'https://www.congress.gov/bill/118hr1234',
    category: 'congress',
    drop_at: '2026-06-17T00:00:00.000Z',
    dedup_cluster_id: '00000000-0000-0000-0000-000000000001',
    curation_mode: 'auto_dominant',
    is_block_exhausted: false,
    additional_sources: [],
  };

  it('returns ≤1 row in default mode with the right column projection', async () => {
    const { db, calls } = fakeDb(
      'news_topics',
      { data: [DROP_ROW], error: null },
      { sidecars: ['opinion_shifts'] },
    );
    const caller = appRouter.createCaller(makeCtx({ db }));

    const result = await caller.feed.list();

    expect(result.topics).toHaveLength(1);
    expect(result.topics[0]).toEqual({
      id: DROP_ROW.id,
      headline: DROP_ROW.headline,
      sourceTitle: DROP_ROW.source_title,
      summary: DROP_ROW.summary,
      primarySourceUrl: DROP_ROW.primary_source_url,
      category: DROP_ROW.category,
      dropAt: DROP_ROW.drop_at,
      dedupClusterId: DROP_ROW.dedup_cluster_id,
      curationMode: DROP_ROW.curation_mode,
      isBlockExhausted: false,
      additionalSources: [],
      // P2.a: userStance is null when the user has no prior shift
      // on this topic. Populated with 'agree' | 'disagree' when a
      // row exists in opinion_shifts. See the dedicated userStance
      // tests below.
      userStance: null,
      // A4: factExplainer is null when the news_topics row has no
      // explainer (fail path or pre-A4 row). Dedicated factExplainer
      // round-trip tests below.
      factExplainer: null,
    });
    // Query shape: select → eq(is_drop, true) → lte(drop_at, cursor) → order desc → limit 1.
    const ops = calls.ops.map((o) => o.op);
    expect(ops).toEqual(['select', 'eq', 'lte', 'order', 'limit']);
    const eqArgs = calls.ops.find((o) => o.op === 'eq')?.args;
    expect(eqArgs).toEqual(['is_drop', true]);
    const limitArgs = calls.ops.find((o) => o.op === 'limit')?.args;
    expect(limitArgs).toEqual([1]);
    const orderArgs = calls.ops.find((o) => o.op === 'order')?.args;
    expect(orderArgs?.[0]).toBe('drop_at');
    expect((orderArgs?.[1] as { ascending: boolean }).ascending).toBe(false);
  });

  it('returns an empty array when no Drop has been published yet', async () => {
    const { db } = fakeDb(
      'news_topics',
      { data: [], error: null },
      { sidecars: ['opinion_shifts'] },
    );
    const caller = appRouter.createCaller(makeCtx({ db }));

    const result = await caller.feed.list();
    expect(result.topics).toEqual([]);
  });

  it('passes a provided cursor through to lte (archive pagination forward-compat)', async () => {
    const { db, calls } = fakeDb(
      'news_topics',
      { data: [], error: null },
      { sidecars: ['opinion_shifts'] },
    );
    const caller = appRouter.createCaller(makeCtx({ db }));

    const cursor = '2026-06-10T00:00:00.000Z';
    await caller.feed.list({ limit: 20, cursor });

    const lteArgs = calls.ops.find((o) => o.op === 'lte')?.args;
    expect(lteArgs).toEqual(['drop_at', cursor]);
    const limitArgs = calls.ops.find((o) => o.op === 'limit')?.args;
    expect(limitArgs).toEqual([20]);
  });

  it('defaults the cursor to now when none is provided', async () => {
    const { db, calls } = fakeDb(
      'news_topics',
      { data: [], error: null },
      { sidecars: ['opinion_shifts'] },
    );
    const caller = appRouter.createCaller(makeCtx({ db }));

    const before = Date.now();
    await caller.feed.list();
    const after = Date.now();

    const lteArgs = calls.ops.find((o) => o.op === 'lte')?.args;
    expect(lteArgs?.[0]).toBe('drop_at');
    const cursorMs = new Date(lteArgs?.[1] as string).getTime();
    expect(cursorMs).toBeGreaterThanOrEqual(before);
    expect(cursorMs).toBeLessThanOrEqual(after);
  });

  it('rejects an out-of-range limit before hitting the DB', async () => {
    const { db, calls } = fakeDb('news_topics', { data: null, error: null });
    const caller = appRouter.createCaller(makeCtx({ db }));

    await expect(caller.feed.list({ limit: 51 })).rejects.toBeInstanceOf(TRPCError);
    expect(calls.ops).toEqual([]);
  });

  it('rejects a malformed cursor before hitting the DB', async () => {
    const { db, calls } = fakeDb('news_topics', { data: null, error: null });
    const caller = appRouter.createCaller(makeCtx({ db }));

    await expect(caller.feed.list({ cursor: 'not-a-date' })).rejects.toBeInstanceOf(TRPCError);
    expect(calls.ops).toEqual([]);
  });

  it('rejects a future cursor at the input schema (HIGH security-reviewer #1)', async () => {
    // A caller passing `cursor=9999-12-31T00:00:00.000Z` could otherwise
    // retrieve any future-dated `is_drop=true` row before its drop_at
    // arrives. The handler also Math.min-clamps as defense in depth.
    const { db, calls } = fakeDb('news_topics', { data: null, error: null });
    const caller = appRouter.createCaller(makeCtx({ db }));

    await expect(caller.feed.list({ cursor: '9999-12-31T00:00:00.000Z' })).rejects.toBeInstanceOf(
      TRPCError,
    );
    expect(calls.ops).toEqual([]);
  });

  it('coerces a non-array additional_sources to []', async () => {
    const { db } = fakeDb(
      'news_topics',
      {
        data: [{ ...DROP_ROW, additional_sources: 'unexpected' as unknown as [] }],
        error: null,
      },
      { sidecars: ['opinion_shifts'] },
    );
    const caller = appRouter.createCaller(makeCtx({ db }));

    const result = await caller.feed.list();
    expect(result.topics[0]?.additionalSources).toEqual([]);
  });

  it('wraps a DB error as INTERNAL_SERVER_ERROR', async () => {
    const { db } = fakeDb('news_topics', {
      data: null,
      error: { message: 'connection reset' },
    });
    const caller = appRouter.createCaller(makeCtx({ db }));

    await expect(caller.feed.list()).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });

  // ---------------------------------------------------------------------------
  // P2.a: userStance per topic from the user's latest opinion_shifts row.
  // ---------------------------------------------------------------------------

  // Two-table fake: news_topics returns the configured topics; each
  // per-topic opinion_shifts lookup returns the latest shift via
  // .maybeSingle(). Mirrors the exact shape feed.list runs after the
  // M1 bounded-query fix (one maybeSingle per topic, not one unbounded
  // in-list fetch).
  function listDb(opts: {
    readonly topics: readonly Record<string, unknown>[];
    readonly latestShiftByTopic: Readonly<Record<string, { after_position: number } | null>>;
    readonly shiftError?: { code?: string; message: string } | null;
  }) {
    const topicsBuilder: Record<string, unknown> = {};
    for (const op of ['select', 'eq', 'in', 'lte', 'order', 'limit']) {
      topicsBuilder[op] = () => topicsBuilder;
    }
    const topicsResult = { data: opts.topics, error: null as { message: string } | null };
    topicsBuilder.then = (resolve: (v: typeof topicsResult) => unknown) =>
      Promise.resolve(resolve(topicsResult));

    function buildShiftsBuilder() {
      let currentTopicId: string | null = null;
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = (col: string, value: string) => {
        if (col === 'topic_id') currentTopicId = value;
        return b;
      };
      b.order = () => b;
      b.limit = () => b;
      b.maybeSingle = () => {
        if (opts.shiftError) {
          return Promise.resolve({ data: null, error: opts.shiftError });
        }
        const data =
          currentTopicId !== null ? (opts.latestShiftByTopic[currentTopicId] ?? null) : null;
        return Promise.resolve({ data, error: null });
      };
      return b;
    }

    return {
      from: (t: string) => (t === 'opinion_shifts' ? buildShiftsBuilder() : topicsBuilder),
      rpc: () => ({ data: null, error: null }),
    };
  }

  it('userStance: null when the user has no shifts on the drop topic', async () => {
    const db = listDb({ topics: [DROP_ROW], latestShiftByTopic: {} });
    const caller = appRouter.createCaller(makeCtx({ db }));
    const result = await caller.feed.list();
    expect(result.topics[0]?.userStance).toBeNull();
  });

  it('userStance: "agree" when the latest shift has after_position > 0', async () => {
    const db = listDb({
      topics: [DROP_ROW],
      latestShiftByTopic: {
        [DROP_ROW.id]: { after_position: 1 },
      },
    });
    const caller = appRouter.createCaller(makeCtx({ db }));
    const result = await caller.feed.list();
    expect(result.topics[0]?.userStance).toBe('agree');
  });

  it('userStance: "disagree" when the latest shift has after_position < 0', async () => {
    const db = listDb({
      topics: [DROP_ROW],
      latestShiftByTopic: {
        [DROP_ROW.id]: { after_position: -1 },
      },
    });
    const caller = appRouter.createCaller(makeCtx({ db }));
    const result = await caller.feed.list();
    expect(result.topics[0]?.userStance).toBe('disagree');
  });

  it('factExplainer: contested payload round-trips with for + against + posture', async () => {
    const db = listDb({
      topics: [
        {
          ...DROP_ROW,
          fact_explainer: {
            for_summary: 'proponents argue...',
            against_summary: 'opponents argue...',
            source_url: 'https://www.sec.gov/example',
            posture: 'contested',
          },
        },
      ],
      latestShiftByTopic: {},
    });
    const caller = appRouter.createCaller(makeCtx({ db }));
    const result = await caller.feed.list();
    expect(result.topics[0]?.factExplainer).toEqual({
      for_summary: 'proponents argue...',
      against_summary: 'opponents argue...',
      source_url: 'https://www.sec.gov/example',
      posture: 'contested',
    });
  });

  it('factExplainer: single_sided empirical payload with empty against_summary', async () => {
    const db = listDb({
      topics: [
        {
          ...DROP_ROW,
          fact_explainer: {
            for_summary: 'the senate passed hr-1234 by a vote of 52-48.',
            against_summary: '',
            source_url: 'https://www.congress.gov/example',
            posture: 'single_sided',
          },
        },
      ],
      latestShiftByTopic: {},
    });
    const caller = appRouter.createCaller(makeCtx({ db }));
    const result = await caller.feed.list();
    expect(result.topics[0]?.factExplainer?.posture).toBe('single_sided');
    expect(result.topics[0]?.factExplainer?.against_summary).toBe('');
  });

  it('factExplainer: null when the column is null (A4 fail path OR pre-A4 row)', async () => {
    const db = listDb({
      topics: [{ ...DROP_ROW, fact_explainer: null }],
      latestShiftByTopic: {},
    });
    const caller = appRouter.createCaller(makeCtx({ db }));
    const result = await caller.feed.list();
    expect(result.topics[0]?.factExplainer).toBeNull();
  });

  it('factExplainer: malformed stored JSON reads as null (defensive narrow)', async () => {
    const db = listDb({
      topics: [
        {
          ...DROP_ROW,
          // Posture missing / wrong value — parseFactExplainer rejects.
          fact_explainer: { for_summary: 'x', posture: 'nonsense' },
        },
      ],
      latestShiftByTopic: {},
    });
    const caller = appRouter.createCaller(makeCtx({ db }));
    const result = await caller.feed.list();
    expect(result.topics[0]?.factExplainer).toBeNull();
  });

  it('factExplainer: non-https source_url reads as null (XSS guard — PR #198 HIGH #2)', async () => {
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'http://example.gov/plain',
      'file:///etc/passwd',
      ' https://example.gov/',
      '\thttps://example.gov/',
    ]) {
      const db = listDb({
        topics: [
          {
            ...DROP_ROW,
            fact_explainer: {
              for_summary: 'proponents argue...',
              against_summary: '',
              source_url: bad,
              posture: 'single_sided',
            },
          },
        ],
        latestShiftByTopic: {},
      });
      const caller = appRouter.createCaller(makeCtx({ db }));
      const result = await caller.feed.list();
      expect(result.topics[0]?.factExplainer).toBeNull();
    }
  });

  it('factExplainer: oversized field reads as null (length guard — PR #198 MEDIUM #2)', async () => {
    const db = listDb({
      topics: [
        {
          ...DROP_ROW,
          fact_explainer: {
            for_summary: 'x'.repeat(1001),
            against_summary: '',
            source_url: 'https://example.gov/',
            posture: 'single_sided',
          },
        },
      ],
      latestShiftByTopic: {},
    });
    const caller = appRouter.createCaller(makeCtx({ db }));
    const result = await caller.feed.list();
    expect(result.topics[0]?.factExplainer).toBeNull();
  });

  it('factExplainer: empty for_summary reads as null (false-balance guard)', async () => {
    const db = listDb({
      topics: [
        {
          ...DROP_ROW,
          fact_explainer: {
            for_summary: '',
            against_summary: 'but...',
            source_url: 'https://example.gov/',
            posture: 'contested',
          },
        },
      ],
      latestShiftByTopic: {},
    });
    const caller = appRouter.createCaller(makeCtx({ db }));
    const result = await caller.feed.list();
    expect(result.topics[0]?.factExplainer).toBeNull();
  });

  it('userStance: null and feed.list still succeeds when the shift lookup errors', async () => {
    const db = listDb({
      topics: [DROP_ROW],
      latestShiftByTopic: {},
      shiftError: { code: '42P01', message: 'relation "opinion_shifts" does not exist' },
    });
    const caller = appRouter.createCaller(makeCtx({ db }));
    const result = await caller.feed.list();
    expect(result.topics[0]?.userStance).toBeNull();
  });
});
