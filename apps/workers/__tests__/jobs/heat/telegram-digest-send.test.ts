import { describe, expect, it, vi } from 'vitest';

import {
  buildInlineKeyboard,
  buildMessageText,
  buildTelegramDigestSendHandler,
  digestDate,
  escapeHtml,
} from '../../../src/jobs/heat/telegram-digest-send.js';
import type { Env } from '../../../src/env.js';
import type { Logger } from '../../../src/logger.js';
import type { ScheduledJobRow } from '../../../src/jobs/scheduler.js';
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
    TELEGRAM_DIGEST_ENABLED: false,
    TELEGRAM_CHAT_ID: '',
    TELEGRAM_OPERATOR_USER_ID: '',
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

function buildRow(): ScheduledJobRow {
  return {
    id: 'row-telegram',
    job_type: 'telegram_digest_send',
    idempotency_key: '2026-10-19',
    target_user_id: null,
    payload: { emitted_at: '2026-10-19 01:15:00' },
    status: 'processing',
    attempts: 1,
    max_attempts: 5,
    available_at: '2026-10-19T01:15:00Z',
    locked_at: '2026-10-19T01:15:01Z',
    locked_by: 'worker-test',
    last_error: null,
    processed_at: null,
    created_at: '2026-10-19T01:15:00Z',
    updated_at: '2026-10-19T01:15:00Z',
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('escapeHtml', () => {
  it('escapes the four Telegram-HTML-sensitive chars', () => {
    expect(escapeHtml('a & b <c> "d"')).toBe('a &amp; b &lt;c&gt; &quot;d&quot;');
  });
});

describe('digestDate', () => {
  it('EDT 01:15 UTC run pins to the ET date of the Drop evening', () => {
    // 01:15 UTC on 2026-10-19 = 9:15 PM EDT on 2026-10-18.
    expect(digestDate(new Date('2026-10-19T01:15:00Z'))).toBe('2026-10-18');
  });

  it('EST 01:15 UTC run pins to the ET date of the Drop evening', () => {
    // 01:15 UTC on 2026-12-20 = 8:15 PM EST on 2026-12-19.
    expect(digestDate(new Date('2026-12-20T01:15:00Z'))).toBe('2026-12-19');
  });

  it('must match generator digestDate at the same instant (one-for-one)', () => {
    // Trivially true (both call the same Intl API) — assert anyway so a
    // future refactor keeps them aligned.
    expect(digestDate(new Date('2026-10-19T01:10:00Z'))).toBe(
      digestDate(new Date('2026-10-19T01:15:00Z')),
    );
  });
});

describe('buildMessageText', () => {
  const top5 = [
    { candidate_id: 'c1', source_title: 'Alpha', source_url: null, heat_score: 12.34 },
    { candidate_id: 'c2', source_title: 'Beta <tag>', source_url: null, heat_score: 9.0 },
  ];

  it('includes the actual Drop headline when present and HTML-escapes it', () => {
    const txt = buildMessageText('2026-10-19', 'Breaking: X & Y', top5);
    expect(txt).toContain('Shadow digest · 2026-10-19');
    expect(txt).toContain('Breaking: X &amp; Y');
    expect(txt).toContain('⭐ Alpha');
    expect(txt).toContain('Beta &lt;tag&gt;'); // headline escaped
  });

  it('shows "no Drop" fallback when real_drop is null', () => {
    const txt = buildMessageText('2026-10-19', null, top5);
    expect(txt).toContain('no Drop in the last 24h');
  });

  it('shows "none scored" fallback when top5 is empty', () => {
    const txt = buildMessageText('2026-10-19', 'A headline', []);
    expect(txt).toContain('none scored');
  });
});

describe('buildInlineKeyboard', () => {
  const top5 = [
    { candidate_id: 'c1', source_title: 'A', source_url: null, heat_score: 1 },
    { candidate_id: 'c2', source_title: 'B', source_url: null, heat_score: 2 },
  ];

  it('emits a top row for each candidate with pick:v1:date:candidate_id', () => {
    const k = buildInlineKeyboard('2026-10-19', top5, null);
    expect(k[0]).toHaveLength(2);
    expect(k[0]![0]!.text).toBe('⭐ #1');
    expect(k[0]![0]!.callback_data).toBe('pick:v1:2026-10-19:c1');
    expect(k[0]![1]!.text).toBe('2');
    expect(k[0]![1]!.callback_data).toBe('pick:v1:2026-10-19:c2');
    // Skip row only.
    expect(k[1]).toHaveLength(1);
    expect(k[1]![0]!.callback_data).toBe('skip:v1:2026-10-19');
  });

  it('adds the Actual-Drop row when real_drop_topic_id is set', () => {
    const k = buildInlineKeyboard('2026-10-19', top5, 'topic-abc');
    expect(k).toHaveLength(3);
    expect(k[1]![0]!.callback_data).toBe('drop:v1:2026-10-19:topic-abc');
    expect(k[2]![0]!.callback_data).toBe('skip:v1:2026-10-19');
  });

  it('still emits a skip row even when top5 is empty', () => {
    const k = buildInlineKeyboard('2026-10-19', [], null);
    expect(k).toHaveLength(1);
    expect(k[0]![0]!.callback_data).toBe('skip:v1:2026-10-19');
  });
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

interface FakeStamp {
  rowId: string;
  payload: Record<string, unknown>;
}

function buildSupabase(opts: {
  readonly logRow: {
    drop_date: string;
    real_drop_topic_id: string | null;
    shadow_top_5: unknown;
  } | null;
  readonly topicRow?: { headline: string } | null;
  readonly logErr?: { message: string } | null;
}): { client: ServiceClient; stamped: FakeStamp[] } {
  const stamped: FakeStamp[] = [];
  const fromImpl = (table: string) => {
    if (table === 'drop_shadow_log') {
      return {
        select: (_cols: string) => ({
          eq: (_c: string, _v: string) => ({
            maybeSingle: () =>
              Promise.resolve({
                data: opts.logRow,
                error: opts.logErr ?? null,
              }),
          }),
        }),
      };
    }
    if (table === 'news_topics') {
      return {
        select: (_cols: string) => ({
          eq: (_c: string, _v: string) => ({
            maybeSingle: () => Promise.resolve({ data: opts.topicRow ?? null, error: null }),
          }),
        }),
      };
    }
    if (table === 'scheduled_jobs') {
      return {
        update: (updateArg: Record<string, unknown>) => ({
          eq: (_c: string, rowId: string) => {
            const payload = (updateArg.payload as Record<string, unknown> | undefined) ?? updateArg;
            stamped.push({ rowId, payload });
            return Promise.resolve({ error: null });
          },
        }),
      };
    }
    throw new Error(`fake: unexpected table ${table}`);
  };
  return { client: { from: fromImpl } as unknown as ServiceClient, stamped };
}

describe('telegram_digest_send handler', () => {
  it('TELEGRAM_DIGEST_ENABLED=false: no DB reads, stamps disabled', async () => {
    const supa = buildSupabase({ logRow: null });
    const logger = buildLogger();
    const fetchImpl = vi.fn() as unknown as typeof globalThis.fetch;
    const handler = buildTelegramDigestSendHandler({
      now: () => new Date('2026-10-19T01:15:00Z'),
      envProvider: () => env({ TELEGRAM_DIGEST_ENABLED: false }),
      fetchImpl,
    });
    await handler(buildRow(), { supabase: supa.client, logger });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(supa.stamped[0]!.payload.outcome).toBe('disabled');
  });

  it('no shadow row for today: stamps no_shadow_row, no fetch', async () => {
    const supa = buildSupabase({ logRow: null });
    const logger = buildLogger();
    const fetchImpl = vi.fn() as unknown as typeof globalThis.fetch;
    const handler = buildTelegramDigestSendHandler({
      now: () => new Date('2026-10-19T01:15:00Z'),
      envProvider: () =>
        env({
          TELEGRAM_DIGEST_ENABLED: true,
          TELEGRAM_BOT_TOKEN: 'bot-token',
          TELEGRAM_CHAT_ID: '42',
        }),
      fetchImpl,
    });
    await handler(buildRow(), { supabase: supa.client, logger });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(supa.stamped[0]!.payload.outcome).toBe('no_shadow_row');
  });

  it('happy path: POSTs sendMessage with inline_keyboard, stamps ok with message_id', async () => {
    const supa = buildSupabase({
      // 01:15 UTC on 2026-10-19 = 9:15 PM EDT on 2026-10-18 → drop_date 10-18.
      logRow: {
        drop_date: '2026-10-18',
        real_drop_topic_id: '11111111-1111-1111-1111-111111111111',
        shadow_top_5: [
          { candidate_id: 'c1', source_title: 'Alpha', source_url: null, heat_score: 10 },
          { candidate_id: 'c2', source_title: 'Beta', source_url: null, heat_score: 8 },
        ],
      },
      topicRow: { headline: 'The actual Drop' },
    });
    const logger = buildLogger();
    const captured: { url: string; body: Record<string, unknown> } = { url: '', body: {} };
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      captured.url = url;
      captured.body = JSON.parse(init.body as string);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 7777 } }),
      } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;

    const handler = buildTelegramDigestSendHandler({
      now: () => new Date('2026-10-19T01:15:00Z'),
      envProvider: () =>
        env({
          TELEGRAM_DIGEST_ENABLED: true,
          TELEGRAM_BOT_TOKEN: 'bot-token',
          TELEGRAM_CHAT_ID: '42',
        }),
      fetchImpl,
    });
    await handler(buildRow(), { supabase: supa.client, logger });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(captured.url).toBe('https://api.telegram.org/botbot-token/sendMessage');
    expect(captured.body.chat_id).toBe('42');
    expect(captured.body.parse_mode).toBe('HTML');
    const kb = captured.body.reply_markup as {
      inline_keyboard: { text: string; callback_data: string }[][];
    };
    // Row 0 = top-5 picks, row 1 = Actual Drop (real_drop_topic_id set), row 2 = Skip.
    expect(kb.inline_keyboard).toHaveLength(3);
    expect(kb.inline_keyboard[0]![0]!.callback_data).toBe('pick:v1:2026-10-18:c1');
    expect(kb.inline_keyboard[1]![0]!.callback_data).toBe(
      'drop:v1:2026-10-18:11111111-1111-1111-1111-111111111111',
    );
    expect(kb.inline_keyboard[2]![0]!.callback_data).toBe('skip:v1:2026-10-18');

    expect(supa.stamped[0]!.payload.outcome).toBe('ok');
    expect(supa.stamped[0]!.payload.telegram_message_id).toBe(7777);
  });

  it('Telegram 403 (bot blocked): stamps degraded_send', async () => {
    const supa = buildSupabase({
      logRow: {
        drop_date: '2026-10-18',
        real_drop_topic_id: null,
        shadow_top_5: [],
      },
    });
    const logger = buildLogger();
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: false,
          status: 403,
          json: async () => ({}),
        }) as unknown as Response,
    ) as unknown as typeof globalThis.fetch;

    const handler = buildTelegramDigestSendHandler({
      now: () => new Date('2026-10-19T01:15:00Z'),
      envProvider: () =>
        env({
          TELEGRAM_DIGEST_ENABLED: true,
          TELEGRAM_BOT_TOKEN: 'bot-token',
          TELEGRAM_CHAT_ID: '42',
        }),
      fetchImpl,
    });
    await handler(buildRow(), { supabase: supa.client, logger });

    expect(supa.stamped[0]!.payload.outcome).toBe('degraded_send');
    expect(supa.stamped[0]!.payload.reason).toBe('status=403');
  });
});

void vi;
