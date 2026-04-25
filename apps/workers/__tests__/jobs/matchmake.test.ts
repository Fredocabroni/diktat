import { describe, expect, it } from 'vitest';

import { enqueueUser, runMatchmakingTick, type UpstashLike } from '../../src/jobs/matchmake.js';
import type { Logger } from '../../src/logger.js';
import type { ServiceClient } from '../../src/supabase.js';

function buildRedis(): UpstashLike & {
  zset: Map<string, Map<string, number>>;
  kv: Map<string, string>;
} {
  const zset = new Map<string, Map<string, number>>();
  const kv = new Map<string, string>();

  function getZ(key: string): Map<string, number> {
    let s = zset.get(key);
    if (!s) {
      s = new Map();
      zset.set(key, s);
    }
    return s;
  }

  return {
    zset,
    kv,
    async zadd(key, sm) {
      getZ(key).set(sm.member, sm.score);
      return 1;
    },
    async zrem(key, ...members) {
      const s = getZ(key);
      let n = 0;
      for (const m of members) {
        if (s.delete(m)) n += 1;
      }
      return n;
    },
    async zscore(key, member) {
      return getZ(key).get(member) ?? null;
    },
    async zrange(key, _start, _stop, opts) {
      const s = getZ(key);
      const sorted = [...s.entries()].sort((a, b) => a[1] - b[1]);
      if (!opts?.withScores) return sorted.map(([m]) => m);
      const out: (string | number)[] = [];
      for (const [m, score] of sorted) {
        out.push(m, score);
      }
      return out;
    },
    async set(key, value) {
      kv.set(key, value);
      return 'OK';
    },
    async get(key) {
      return kv.get(key) ?? null;
    },
    async del(...keys) {
      let n = 0;
      for (const k of keys) {
        if (kv.delete(k)) n += 1;
        if (zset.delete(k)) n += 1;
      }
      return n;
    },
  };
}

interface FakeSupabase {
  client: ServiceClient;
  battlesInserted: { mode: string; status: string; ap_pot: number }[];
  participantsInserted: { battle_id: string; user_id: string; seat: number }[][];
  bots: { id: string; current_ap: number }[];
}

function buildSupabase(opts: { bots?: FakeSupabase['bots'] } = {}): FakeSupabase {
  const state: FakeSupabase = {
    client: null as unknown as ServiceClient,
    battlesInserted: [],
    participantsInserted: [],
    bots: opts.bots ?? [],
  };

  let nextBattleId = 1;

  const fromImpl = (table: string) => {
    if (table === 'battles') {
      return {
        insert(payload: { mode: string; status: string; ap_pot: number }) {
          state.battlesInserted.push(payload);
          const id = `battle-${nextBattleId++}`;
          return {
            select(_cols: string) {
              return {
                maybeSingle: async () => ({ data: { id }, error: null }),
              };
            },
          };
        },
      };
    }
    if (table === 'battle_participants') {
      return {
        insert(payload: { battle_id: string; user_id: string; seat: number }[]) {
          state.participantsInserted.push(payload);
          return Promise.resolve({ error: null });
        },
      };
    }
    if (table === 'users') {
      const filters: Record<string, unknown> = {};
      const builder = {
        select(_cols: string) {
          return builder;
        },
        eq(col: string, val: unknown) {
          filters[col] = val;
          return builder;
        },
        gte(col: string, val: number) {
          filters[`${col}_gte`] = val;
          return builder;
        },
        lte(col: string, val: number) {
          filters[`${col}_lte`] = val;
          return builder;
        },
        limit(_n: number) {
          const isBot = filters.is_bot === true;
          if (!isBot) return Promise.resolve({ data: [], error: null });
          const min = filters.current_ap_gte as number | undefined;
          const max = filters.current_ap_lte as number | undefined;
          const matches = state.bots
            .filter(
              (b) =>
                (min === undefined || b.current_ap >= min) &&
                (max === undefined || b.current_ap <= max),
            )
            .map((b) => ({ id: b.id, current_ap: b.current_ap }));
          return Promise.resolve({ data: matches, error: null });
        },
      };
      return builder;
    }
    throw new Error(`fakeSupabase: unexpected table ${table}`);
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

describe('runMatchmakingTick', () => {
  it('no-ops on an empty queue', async () => {
    const redis = buildRedis();
    const supabase = buildSupabase();
    const logger = buildLogger();

    const result = await runMatchmakingTick({ redis, supabase: supabase.client, logger });

    expect(result).toEqual({ scanned: 0, matchesCreated: 0, botFallbacks: 0, errors: 0 });
    expect(supabase.battlesInserted).toEqual([]);
  });

  it('pairs two humans whose AP is within ±200', async () => {
    const redis = buildRedis();
    const supabase = buildSupabase();
    const logger = buildLogger();
    const t0 = 1_000_000;

    await enqueueUser({
      userId: 'alice',
      ap: 600,
      mode: 'trivia',
      redis,
      now: () => t0,
    });
    await enqueueUser({
      userId: 'bob',
      ap: 720,
      mode: 'trivia',
      redis,
      now: () => t0 + 100,
    });

    const result = await runMatchmakingTick({
      redis,
      supabase: supabase.client,
      logger,
      now: () => t0 + 500,
    });

    expect(result.matchesCreated).toBe(1);
    expect(result.botFallbacks).toBe(0);
    expect(supabase.battlesInserted).toHaveLength(1);
    expect(supabase.participantsInserted).toHaveLength(1);
    const seats = supabase.participantsInserted[0]!;
    expect(seats.map((s) => s.user_id).sort()).toEqual(['alice', 'bob']);
    expect(redis.zset.get('mm:trivia:queue')?.size ?? 0).toBe(0);
    expect(redis.kv.get('mm:trivia:matched:alice')).toBeDefined();
    const matched = JSON.parse(redis.kv.get('mm:trivia:matched:alice')!);
    expect(matched.opponentIsBot).toBe(false);
    expect(matched.role).toBe('human');
  });

  it('does not pair humans outside the ±200 band when both are fresh', async () => {
    const redis = buildRedis();
    const supabase = buildSupabase();
    const logger = buildLogger();
    const t0 = 1_000_000;

    await enqueueUser({ userId: 'alice', ap: 200, mode: 'trivia', redis, now: () => t0 });
    await enqueueUser({ userId: 'bob', ap: 1500, mode: 'trivia', redis, now: () => t0 + 50 });

    const result = await runMatchmakingTick({
      redis,
      supabase: supabase.client,
      logger,
      now: () => t0 + 500,
    });

    expect(result.scanned).toBe(2);
    expect(result.matchesCreated).toBe(0);
    expect(result.botFallbacks).toBe(0);
    expect(supabase.battlesInserted).toEqual([]);
  });

  it('falls back to a bot opponent after 30s when no human match exists', async () => {
    const redis = buildRedis();
    const supabase = buildSupabase({
      bots: [
        { id: 'bot-cool', current_ap: 850 },
        { id: 'bot-warm', current_ap: 950 },
      ],
    });
    const logger = buildLogger();
    const t0 = 1_000_000;

    await enqueueUser({ userId: 'alice', ap: 800, mode: 'trivia', redis, now: () => t0 });

    const result = await runMatchmakingTick({
      redis,
      supabase: supabase.client,
      logger,
      now: () => t0 + 31_000,
    });

    expect(result.matchesCreated).toBe(1);
    expect(result.botFallbacks).toBe(1);
    expect(supabase.battlesInserted).toHaveLength(1);
    const seats = supabase.participantsInserted[0]!;
    const userIds = seats.map((s) => s.user_id);
    expect(userIds).toContain('alice');
    expect(userIds).toContain('bot-cool'); // closest to 800
    const matched = JSON.parse(redis.kv.get('mm:trivia:matched:alice')!);
    expect(matched.opponentIsBot).toBe(true);
    expect(matched.role).toBe('practice');
  });

  it('does nothing when a stale human waits but no bot is in band', async () => {
    const redis = buildRedis();
    const supabase = buildSupabase({ bots: [] });
    const logger = buildLogger();
    const t0 = 1_000_000;

    await enqueueUser({ userId: 'alice', ap: 800, mode: 'trivia', redis, now: () => t0 });

    const result = await runMatchmakingTick({
      redis,
      supabase: supabase.client,
      logger,
      now: () => t0 + 31_000,
    });

    expect(result.matchesCreated).toBe(0);
    expect(result.botFallbacks).toBe(0);
    expect(supabase.battlesInserted).toEqual([]);
  });
});
