// telegram-digest-poll — long-polling consumer of Telegram
// callback_query events from the shadow-digest inline keyboard.
//
// Design: an in-process loop (same pattern as privy-provision's
// LISTEN loop), fire-and-forget at workers boot behind
// TELEGRAM_DIGEST_ENABLED. On each tick we call
// GET /bot<token>/getUpdates?timeout=25&offset=<n>&allowed_updates=["callback_query"]
// — a 25-second long poll — then dispatch each callback_query to
// handleCallbackQuery(). Updates whose chat.id does NOT match
// TELEGRAM_OPERATOR_CHAT_ID are IGNORED and logged (operator-only
// — the whole point of this UI).
//
// Offset state is in-memory only. On restart the loop resumes from
// the HIGHEST update_id Telegram still has in its 24h buffer; this
// is shadow-only and a dropped callback at exact restart boundary
// is acceptable (operator clicks again). A dedicated offset table
// is deferred to the BullMQ-TCP migration (see CLAUDE.md).
//
// Callback_data shapes (compact, under Telegram's 64-byte cap):
//   pick:v1:<drop_date>:<candidate_id>   — operator picked a top-5 entry
//   drop:v1:<drop_date>:<topic_id>       — operator picked the actual Drop
//   skip:v1:<drop_date>                  — operator skipped the day
//
// On pick/drop → call record_drop_shadow_operator_pick with a short
// note. On skip → no RPC call (shadow log stays operator-null for
// the day). All three answer the callback_query so Telegram shows
// the toast and the client stops spinning.

import { scrubMessage } from '@diktat/shared/alerts';

import { loadEnv, type Env } from '../../env.js';
import type { Logger } from '../../logger.js';
import type { ServiceClient } from '../../supabase.js';

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const LONG_POLL_TIMEOUT_SEC = 25;
const FETCH_TIMEOUT_MS = (LONG_POLL_TIMEOUT_SEC + 5) * 1000;
const BACKOFF_ON_ERROR_MS = 5_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TelegramCallbackQuery {
  readonly id: string;
  readonly from: { readonly id: number };
  readonly message?: { readonly chat?: { readonly id: number } };
  readonly data?: string;
}

export interface TelegramUpdate {
  readonly update_id: number;
  readonly callback_query?: TelegramCallbackQuery;
}

export type ParsedCallback =
  | { readonly kind: 'pick'; readonly dropDate: string; readonly candidateId: string }
  | { readonly kind: 'drop'; readonly dropDate: string; readonly topicId: string }
  | { readonly kind: 'skip'; readonly dropDate: string }
  | { readonly kind: 'invalid'; readonly reason: string };

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse the compact callback_data shapes. Rejects anything that
 *  doesn't match the exact `kind:v1:...` shape — defence-in-depth
 *  against a malformed payload reaching the RPC. */
export function parseCallbackData(raw: string | undefined): ParsedCallback {
  if (!raw) return { kind: 'invalid', reason: 'empty' };
  const parts = raw.split(':');
  if (parts.length < 3) return { kind: 'invalid', reason: 'too_few_parts' };
  const [kind, version, dropDate, ...rest] = parts;
  if (version !== 'v1') return { kind: 'invalid', reason: 'bad_version' };
  if (!dropDate || !DATE_RE.test(dropDate)) return { kind: 'invalid', reason: 'bad_date' };
  if (kind === 'skip') {
    if (rest.length > 0) return { kind: 'invalid', reason: 'skip_extra_parts' };
    return { kind: 'skip', dropDate };
  }
  if (kind === 'pick' || kind === 'drop') {
    const id = rest.join(':');
    if (!id || !UUID_RE.test(id)) return { kind: 'invalid', reason: 'bad_uuid' };
    return kind === 'pick'
      ? { kind: 'pick', dropDate, candidateId: id }
      : { kind: 'drop', dropDate, topicId: id };
  }
  return { kind: 'invalid', reason: 'unknown_kind' };
}

/** Check whether an incoming callback originates from the operator
 *  chat. Both the message's chat and the clicking user must match
 *  the configured operator chat_id (for a 1:1 bot DM they're the
 *  same; for a group chat they'd differ). */
export function isFromOperator(q: TelegramCallbackQuery, operatorChatId: string): boolean {
  if (operatorChatId.length === 0) return false;
  const operatorId = Number.parseInt(operatorChatId, 10);
  if (!Number.isFinite(operatorId)) return false;
  if (q.from.id !== operatorId) return false;
  const chatId = q.message?.chat?.id;
  if (chatId !== undefined && chatId !== operatorId) return false;
  return true;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function fetchWithTimeout(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
  });
  try {
    return (await Promise.race([fetchImpl(url, init), timeout])) as Response;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function postJson(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  body: Record<string, unknown>,
): Promise<void> {
  await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    FETCH_TIMEOUT_MS,
  );
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

interface Deps {
  readonly supabase: ServiceClient;
  readonly logger: Logger;
  readonly fetch: typeof globalThis.fetch;
  readonly env: Env;
}

/** Handle a single operator-authorised callback_query. Exported for
 *  tests. */
export async function handleCallbackQuery(q: TelegramCallbackQuery, deps: Deps): Promise<void> {
  const parsed = parseCallbackData(q.data);
  const answerUrl = `${TELEGRAM_API_BASE}/bot${deps.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`;

  if (parsed.kind === 'invalid') {
    deps.logger.warn({
      event: 'telegram_digest_poll.callback_invalid',
      reason: parsed.reason,
    });
    await postJson(deps.fetch, answerUrl, {
      callback_query_id: q.id,
      text: '⚠️ Invalid button payload.',
    });
    return;
  }

  if (parsed.kind === 'skip') {
    deps.logger.info({
      event: 'telegram_digest_poll.operator_skip',
      drop_date: parsed.dropDate,
    });
    await postJson(deps.fetch, answerUrl, {
      callback_query_id: q.id,
      text: '⏭ Skipped — no operator pick recorded.',
    });
    return;
  }

  // pick / drop → both write through record_drop_shadow_operator_pick.
  const pickId = parsed.kind === 'pick' ? parsed.candidateId : parsed.topicId;
  const noteKind = parsed.kind === 'pick' ? 'top5_candidate' : 'actual_drop_topic_id';
  const note = `telegram: ${noteKind}`;

  const { error: rpcErr } = await deps.supabase.rpc('record_drop_shadow_operator_pick', {
    p_drop_date: parsed.dropDate,
    p_candidate_id: pickId,
    p_notes: note,
  });

  if (rpcErr) {
    deps.logger.warn({
      event: 'telegram_digest_poll.rpc_failed',
      drop_date: parsed.dropDate,
      kind: parsed.kind,
      message: scrubMessage(rpcErr.message),
    });
    await postJson(deps.fetch, answerUrl, {
      callback_query_id: q.id,
      text: '⚠️ Failed to record pick — see logs.',
    });
    return;
  }

  deps.logger.info({
    event: 'telegram_digest_poll.pick_recorded',
    drop_date: parsed.dropDate,
    kind: parsed.kind,
  });
  await postJson(deps.fetch, answerUrl, {
    callback_query_id: q.id,
    text: parsed.kind === 'pick' ? '✓ Logged your top-5 pick.' : '✓ Logged actual-Drop pick.',
  });
}

/** Fetch one long-poll batch of updates and dispatch each. Returns
 *  the new offset. Exported for tests. */
export async function pollOnce(
  offset: number,
  deps: Deps,
): Promise<{ nextOffset: number; count: number }> {
  const url =
    `${TELEGRAM_API_BASE}/bot${deps.env.TELEGRAM_BOT_TOKEN}/getUpdates` +
    `?timeout=${LONG_POLL_TIMEOUT_SEC}` +
    `&offset=${offset}` +
    `&allowed_updates=${encodeURIComponent('["callback_query"]')}`;
  const res = await fetchWithTimeout(deps.fetch, url, { method: 'GET' }, FETCH_TIMEOUT_MS);
  if (!res.ok) {
    deps.logger.warn({
      event: 'telegram_digest_poll.get_updates_http_failed',
      status: res.status,
    });
    return { nextOffset: offset, count: 0 };
  }
  let body: { result?: TelegramUpdate[] };
  try {
    body = (await res.json()) as { result?: TelegramUpdate[] };
  } catch {
    deps.logger.warn({ event: 'telegram_digest_poll.get_updates_parse_failed' });
    return { nextOffset: offset, count: 0 };
  }
  const updates = Array.isArray(body.result) ? body.result : [];
  let nextOffset = offset;
  for (const u of updates) {
    nextOffset = Math.max(nextOffset, u.update_id + 1);
    const q = u.callback_query;
    if (!q) continue;
    if (!isFromOperator(q, deps.env.TELEGRAM_OPERATOR_CHAT_ID)) {
      deps.logger.warn({
        event: 'telegram_digest_poll.ignored_non_operator',
        from_id: q.from.id,
        chat_id: q.message?.chat?.id,
      });
      // Silently drop — do NOT answerCallbackQuery for non-operator;
      // we don't want to echo any text into a chat we didn't expect.
      continue;
    }
    try {
      await handleCallbackQuery(q, deps);
    } catch (err) {
      deps.logger.warn({
        event: 'telegram_digest_poll.handle_failed',
        message: scrubMessage(err instanceof Error ? err.message : String(err)),
      });
    }
  }
  return { nextOffset, count: updates.length };
}

// ---------------------------------------------------------------------------
// Boot wiring
// ---------------------------------------------------------------------------

export interface LongPollController {
  /** Stop the loop at the next iteration boundary. */
  readonly stop: () => void;
  /** Resolves when the loop has fully exited. */
  readonly done: Promise<void>;
}

/** Start the Telegram long-poll loop. Fire-and-forget at workers
 *  boot. When TELEGRAM_DIGEST_ENABLED=false this logs a skip and
 *  returns a controller whose `done` resolves immediately. */
export function startTelegramDigestLongPoll(opts: {
  readonly supabase: ServiceClient;
  readonly logger: Logger;
  readonly fetch?: typeof globalThis.fetch;
  readonly envProvider?: () => Env;
  readonly sleepMs?: (ms: number) => Promise<void>;
}): LongPollController {
  const env = (opts.envProvider ?? loadEnv)();
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const sleepMs = opts.sleepMs ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  if (!env.TELEGRAM_DIGEST_ENABLED) {
    opts.logger.info({ event: 'telegram_digest_poll.disabled' });
    return { stop: () => {}, done: Promise.resolve() };
  }
  if (!fetchImpl) {
    opts.logger.warn({ event: 'telegram_digest_poll.no_fetch_impl' });
    return { stop: () => {}, done: Promise.resolve() };
  }
  const deps: Deps = {
    supabase: opts.supabase,
    logger: opts.logger,
    fetch: fetchImpl,
    env,
  };
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  const done = (async () => {
    let offset = 0;
    opts.logger.info({ event: 'telegram_digest_poll.started' });
    while (!stopped) {
      try {
        const r = await pollOnce(offset, deps);
        offset = r.nextOffset;
      } catch (err) {
        opts.logger.warn({
          event: 'telegram_digest_poll.poll_failed',
          message: scrubMessage(err instanceof Error ? err.message : String(err)),
        });
        await sleepMs(BACKOFF_ON_ERROR_MS);
      }
    }
    opts.logger.info({ event: 'telegram_digest_poll.stopped' });
  })();
  return { stop, done };
}
