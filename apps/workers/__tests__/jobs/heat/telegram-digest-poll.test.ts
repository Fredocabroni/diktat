import { describe, expect, it, vi } from 'vitest';

import {
  handleCallbackQuery,
  isFromOperator,
  parseCallbackData,
  pollOnce,
  startTelegramDigestLongPoll,
  type TelegramCallbackQuery,
} from '../../../src/jobs/heat/telegram-digest-poll.js';
import type { Env } from '../../../src/env.js';
import type { Logger } from '../../../src/logger.js';
import type { ServiceClient } from '../../../src/supabase.js';

function env(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
    DATABASE_URL: 'https://example.com',
    SUPABASE_URL: 'https://example.com',
    SUPABASE_SERVICE_ROLE_KEY: 'x',
    UPSTASH_REDIS_REST_URL: 'https://example.com',
    UPSTASH_REDIS_REST_TOKEN: 'x',
    PRIVY_ENABLED: false,
    PRIVY_APP_ID: '',
    PRIVY_APP_SECRET: '',
    VAPID_PUBLIC_KEY: '',
    VAPID_PRIVATE_KEY: '',
    VAPID_SUBJECT: '',
    GDELT_ENABLED: false,
    WIKIMEDIA_ENABLED: false,
    HEAT_ENABLED: true,
    X_TRENDS_ENABLED: false,
    X_BEARER_TOKEN: '',
    BLUESKY_ENABLED: false,
    TELEGRAM_DIGEST_ENABLED: true,
    TELEGRAM_BOT_TOKEN: 'bot-token',
    TELEGRAM_OPERATOR_CHAT_ID: '42',
    ...overrides,
  } as Env;
}

function buildLogger(): Logger & { calls: { level: string; obj: Record<string, unknown> }[] } {
  const calls: { level: string; obj: Record<string, unknown> }[] = [];
  const push = (level: string) => (obj: Record<string, unknown>) => {
    calls.push({ level, obj });
  };
  return {
    info: push('info') as Logger['info'],
    warn: push('warn') as Logger['warn'],
    error: push('error') as Logger['error'],
    debug: push('debug') as Logger['debug'],
    calls,
  };
}

const UUID_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const UUID_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

// ---------------------------------------------------------------------------
// parseCallbackData
// ---------------------------------------------------------------------------

describe('parseCallbackData', () => {
  it('parses pick with a UUID', () => {
    const p = parseCallbackData(`pick:v1:2026-10-19:${UUID_A}`);
    expect(p.kind).toBe('pick');
    if (p.kind === 'pick') {
      expect(p.dropDate).toBe('2026-10-19');
      expect(p.candidateId).toBe(UUID_A);
    }
  });

  it('parses drop with a UUID', () => {
    const p = parseCallbackData(`drop:v1:2026-10-19:${UUID_B}`);
    expect(p.kind).toBe('drop');
  });

  it('parses skip (no trailing id)', () => {
    const p = parseCallbackData('skip:v1:2026-10-19');
    expect(p.kind).toBe('skip');
  });

  it('rejects bad version', () => {
    const p = parseCallbackData(`pick:v2:2026-10-19:${UUID_A}`);
    expect(p.kind).toBe('invalid');
  });

  it('rejects bad date', () => {
    const p = parseCallbackData(`pick:v1:not-a-date:${UUID_A}`);
    expect(p.kind).toBe('invalid');
  });

  it('rejects non-UUID candidate id', () => {
    const p = parseCallbackData('pick:v1:2026-10-19:not-a-uuid');
    expect(p.kind).toBe('invalid');
  });

  it('rejects unknown kind', () => {
    const p = parseCallbackData(`frob:v1:2026-10-19:${UUID_A}`);
    expect(p.kind).toBe('invalid');
  });

  it('rejects empty / undefined', () => {
    expect(parseCallbackData(undefined).kind).toBe('invalid');
    expect(parseCallbackData('').kind).toBe('invalid');
  });
});

// ---------------------------------------------------------------------------
// isFromOperator
// ---------------------------------------------------------------------------

describe('isFromOperator', () => {
  const q = (fromId: number, chatId?: number): TelegramCallbackQuery => ({
    id: 'cbq-1',
    from: { id: fromId },
    message: chatId === undefined ? undefined : { chat: { id: chatId } },
    data: `skip:v1:2026-10-19`,
  });

  it('matches operator from.id (1:1 DM, no message.chat passed)', () => {
    expect(isFromOperator(q(42), '42')).toBe(true);
  });

  it('matches when both from.id and chat.id are operator', () => {
    expect(isFromOperator(q(42, 42), '42')).toBe(true);
  });

  it('rejects non-operator from.id', () => {
    expect(isFromOperator(q(999), '42')).toBe(false);
  });

  it('rejects when chat.id disagrees with operator (group chat case)', () => {
    expect(isFromOperator(q(42, 999), '42')).toBe(false);
  });

  it('rejects empty operator chat id', () => {
    expect(isFromOperator(q(42), '')).toBe(false);
  });

  it('rejects non-numeric operator chat id', () => {
    expect(isFromOperator(q(42), 'oops')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleCallbackQuery
// ---------------------------------------------------------------------------

function buildSupabase(opts: { readonly rpcErr?: { message: string } | null }): {
  client: ServiceClient;
  calls: Array<{ fn: string; args: Record<string, unknown> }>;
} {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const rpc = (fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args });
    return Promise.resolve({ error: opts.rpcErr ?? null });
  };
  return { client: { rpc } as unknown as ServiceClient, calls };
}

describe('handleCallbackQuery', () => {
  const makeQ = (data: string): TelegramCallbackQuery => ({
    id: 'cbq-99',
    from: { id: 42 },
    message: { chat: { id: 42 } },
    data,
  });

  it('pick: calls record_drop_shadow_operator_pick and answers callback', async () => {
    const supa = buildSupabase({});
    const logger = buildLogger();
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      posts.push({ url, body: JSON.parse(init.body as string) });
      return { ok: true } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;

    await handleCallbackQuery(makeQ(`pick:v1:2026-10-19:${UUID_A}`), {
      supabase: supa.client,
      logger,
      fetch: fetchImpl,
      env: env(),
    });

    expect(supa.calls).toEqual([
      {
        fn: 'record_drop_shadow_operator_pick',
        args: {
          p_drop_date: '2026-10-19',
          p_candidate_id: UUID_A,
          p_notes: 'telegram: top5_candidate',
        },
      },
    ]);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe('https://api.telegram.org/botbot-token/answerCallbackQuery');
    expect(posts[0]!.body.callback_query_id).toBe('cbq-99');
  });

  it('drop: records with actual_drop_topic_id note', async () => {
    const supa = buildSupabase({});
    const logger = buildLogger();
    const fetchImpl = vi.fn(
      async () => ({ ok: true }) as unknown as Response,
    ) as unknown as typeof globalThis.fetch;
    await handleCallbackQuery(makeQ(`drop:v1:2026-10-19:${UUID_B}`), {
      supabase: supa.client,
      logger,
      fetch: fetchImpl,
      env: env(),
    });
    expect(supa.calls[0]!.args.p_notes).toBe('telegram: actual_drop_topic_id');
    expect(supa.calls[0]!.args.p_candidate_id).toBe(UUID_B);
  });

  it('skip: no RPC call, still answers callback', async () => {
    const supa = buildSupabase({});
    const logger = buildLogger();
    const fetchImpl = vi.fn(
      async () => ({ ok: true }) as unknown as Response,
    ) as unknown as typeof globalThis.fetch;
    await handleCallbackQuery(makeQ('skip:v1:2026-10-19'), {
      supabase: supa.client,
      logger,
      fetch: fetchImpl,
      env: env(),
    });
    expect(supa.calls).toHaveLength(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('invalid: no RPC call, answers callback with warn', async () => {
    const supa = buildSupabase({});
    const logger = buildLogger();
    const fetchImpl = vi.fn(
      async () => ({ ok: true }) as unknown as Response,
    ) as unknown as typeof globalThis.fetch;
    await handleCallbackQuery(makeQ('garbage'), {
      supabase: supa.client,
      logger,
      fetch: fetchImpl,
      env: env(),
    });
    expect(supa.calls).toHaveLength(0);
    expect(
      logger.calls.find(
        (c) => (c.obj as { event?: string }).event === 'telegram_digest_poll.callback_invalid',
      ),
    ).toBeDefined();
  });

  it('rpc error: logs warn, answers callback with failure toast', async () => {
    const supa = buildSupabase({ rpcErr: { message: 'simulated rpc fail' } });
    const logger = buildLogger();
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      posts.push({ url, body: JSON.parse(init.body as string) });
      return { ok: true } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;
    await handleCallbackQuery(makeQ(`pick:v1:2026-10-19:${UUID_A}`), {
      supabase: supa.client,
      logger,
      fetch: fetchImpl,
      env: env(),
    });
    expect(
      logger.calls.find(
        (c) => (c.obj as { event?: string }).event === 'telegram_digest_poll.rpc_failed',
      ),
    ).toBeDefined();
    expect((posts[0]!.body.text as string).startsWith('⚠️')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// pollOnce
// ---------------------------------------------------------------------------

describe('pollOnce', () => {
  it('non-operator updates are IGNORED (no RPC, no answerCallbackQuery)', async () => {
    const supa = buildSupabase({});
    const logger = buildLogger();
    const posts: Array<{ url: string }> = [];
    const fetchImpl = vi.fn(async (url: string) => {
      posts.push({ url });
      if (url.includes('/getUpdates')) {
        return {
          ok: true,
          json: async () => ({
            result: [
              {
                update_id: 101,
                callback_query: {
                  id: 'bad',
                  from: { id: 999 }, // not operator (42)
                  message: { chat: { id: 999 } },
                  data: `pick:v1:2026-10-19:${UUID_A}`,
                },
              },
            ],
          }),
        } as unknown as Response;
      }
      return { ok: true, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;

    const r = await pollOnce(0, {
      supabase: supa.client,
      logger,
      fetch: fetchImpl,
      env: env(),
    });
    expect(r.nextOffset).toBe(102);
    expect(supa.calls).toHaveLength(0);
    // Only the getUpdates URL was called, no answerCallbackQuery.
    expect(posts.every((p) => p.url.includes('/getUpdates'))).toBe(true);
    expect(
      logger.calls.find(
        (c) => (c.obj as { event?: string }).event === 'telegram_digest_poll.ignored_non_operator',
      ),
    ).toBeDefined();
  });

  it('operator update is dispatched; nextOffset advances past highest update_id', async () => {
    const supa = buildSupabase({});
    const logger = buildLogger();
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/getUpdates')) {
        return {
          ok: true,
          json: async () => ({
            result: [
              {
                update_id: 50,
                callback_query: {
                  id: 'cbq-ok',
                  from: { id: 42 },
                  message: { chat: { id: 42 } },
                  data: 'skip:v1:2026-10-19',
                },
              },
            ],
          }),
        } as unknown as Response;
      }
      return { ok: true, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;

    const r = await pollOnce(0, {
      supabase: supa.client,
      logger,
      fetch: fetchImpl,
      env: env(),
    });
    expect(r.nextOffset).toBe(51);
    // Skip → still answers the callback.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('empty result: no dispatch, offset unchanged', async () => {
    const supa = buildSupabase({});
    const logger = buildLogger();
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: true,
          json: async () => ({ result: [] }),
        }) as unknown as Response,
    ) as unknown as typeof globalThis.fetch;
    const r = await pollOnce(0, {
      supabase: supa.client,
      logger,
      fetch: fetchImpl,
      env: env(),
    });
    expect(r.nextOffset).toBe(0);
    expect(r.count).toBe(0);
    expect(supa.calls).toHaveLength(0);
  });

  it('getUpdates HTTP 500: logs warn, offset unchanged', async () => {
    const supa = buildSupabase({});
    const logger = buildLogger();
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: false,
          status: 500,
          json: async () => ({}),
        }) as unknown as Response,
    ) as unknown as typeof globalThis.fetch;
    const r = await pollOnce(5, {
      supabase: supa.client,
      logger,
      fetch: fetchImpl,
      env: env(),
    });
    expect(r.nextOffset).toBe(5);
    expect(
      logger.calls.find(
        (c) =>
          (c.obj as { event?: string }).event === 'telegram_digest_poll.get_updates_http_failed',
      ),
    ).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// startTelegramDigestLongPoll
// ---------------------------------------------------------------------------

describe('startTelegramDigestLongPoll', () => {
  it('TELEGRAM_DIGEST_ENABLED=false: logs disabled, done resolves immediately', async () => {
    const supa = buildSupabase({});
    const logger = buildLogger();
    const fetchImpl = vi.fn() as unknown as typeof globalThis.fetch;
    const ctl = startTelegramDigestLongPoll({
      supabase: supa.client,
      logger,
      fetch: fetchImpl,
      envProvider: () => env({ TELEGRAM_DIGEST_ENABLED: false }),
    });
    await ctl.done;
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(
      logger.calls.find(
        (c) => (c.obj as { event?: string }).event === 'telegram_digest_poll.disabled',
      ),
    ).toBeDefined();
  });
});

void vi;
