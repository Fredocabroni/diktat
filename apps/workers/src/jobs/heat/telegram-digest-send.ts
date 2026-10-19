// telegram_digest_send — scheduler-spine worker that posts the day's
// drop_shadow_log row to the operator's Telegram chat as a review
// message with inline-keyboard buttons.
//
// Shadow-only. TELEGRAM_DIGEST_ENABLED=false by default. The operator
// picks a candidate via the inline keyboard; the long-poll loop
// (telegram-digest-poll.ts) writes the pick back through
// record_drop_shadow_operator_pick. This handler is the SEND side only.
//
// Message shape (plain text; parse_mode='HTML' for inline bold):
//
//   📊 <b>Shadow digest · 2026-10-19</b>
//
//   <b>Actual Drop:</b> <headline>
//
//   <b>Top 5 by heat_score:</b>
//   1. ⭐ <headline>  (12.3)
//   2. <headline>  (10.0)
//   …
//
//   <i>Pick one — this writes to drop_shadow_log.operator_pick.</i>
//
// Inline keyboard rows:
//   [⭐ #1] [2] [3] [4] [5]
//   [📰 Actual Drop]      (when real_drop_topic_id is non-null)
//   [⏭ Skip]
//
// Button callback_data shape (compact, under Telegram's 64-byte cap):
//   pick:v1:<drop_date>:<candidate_id>
//   drop:v1:<drop_date>:<news_topics_id>
//   skip:v1:<drop_date>
//
// Why not just use the alerter? The alerter is for terse ops alerts
// and has NO callback/inline-keyboard surface — it's a fire-and-forget
// text sink. This handler needs the full Bot API: inline keyboards +
// callback_query + answerCallbackQuery. So we build directly against
// api.telegram.org here, re-using the alerter's URL-building pattern
// (bot token in the URL, never logged).

import type { Database } from '@diktat/db';
import { scrubMessage } from '@diktat/shared/alerts';

import { loadEnv, type Env } from '../../env.js';
import type { JobHandler, ScheduledJobRow } from '../scheduler.js';

type ScheduledJobsUpdate = Database['public']['Tables']['scheduled_jobs']['Update'];

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const FETCH_TIMEOUT_MS = 10_000;

// Telegram's hard limit on callback_data is 64 bytes. The longest
// shape above is `pick:v1:YYYY-MM-DD:<uuid>` = 13 + 10 + 1 + 36 = 60 bytes.
// Still safe but worth keeping an eye on if the versioning changes.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ShadowTopEntry {
  readonly candidate_id: string;
  readonly source_title: string;
  readonly source_url: string | null;
  readonly heat_score: number;
}

interface ShadowLogRow {
  readonly drop_date: string;
  readonly real_drop_topic_id: string | null;
  readonly shadow_top_5: ShadowTopEntry[];
}

interface InlineKeyboardButton {
  readonly text: string;
  readonly callback_data: string;
}

interface StampPayload {
  readonly emitted_at?: string;
  readonly outcome: 'ok' | 'disabled' | 'no_shadow_row' | 'degraded_db' | 'degraded_send';
  readonly drop_date?: string;
  readonly telegram_message_id?: number;
  readonly reason?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** HTML-escape text for Telegram parse_mode='HTML'. Only four chars
 *  need escaping per the Bot API docs: `<`, `>`, `&`, `"`. */
export function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Compact decimal: 2 fractional digits, no trailing zeros. */
function fmtScore(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2).replace(/\.?0+$/, '');
}

/** The ET date of the Drop that this digest reviews. The send
 *  cron fires at 01:15 UTC — 9:15 PM EDT / 8:15 PM EST — so the
 *  firing moment's America/New_York date is the ET date of
 *  tonight's 8 PM ET Drop. Must match the generator's digestDate()
 *  one-for-one; both use the same Intl API so DST transitions
 *  stay aligned. */
export function digestDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function buildMessageText(
  dropDate: string,
  realDropHeadline: string | null,
  top5: ShadowTopEntry[],
): string {
  const lines: string[] = [];
  lines.push(`📊 <b>Shadow digest · ${escapeHtml(dropDate)}</b>`);
  lines.push('');
  if (realDropHeadline === null) {
    lines.push(`<b>Actual Drop:</b> <i>no Drop in the last 24h</i>`);
  } else {
    lines.push(`<b>Actual Drop:</b> ${escapeHtml(realDropHeadline)}`);
  }
  lines.push('');
  if (top5.length === 0) {
    lines.push(`<b>Top candidates by heat_score:</b> <i>none scored</i>`);
  } else {
    lines.push(`<b>Top ${top5.length} by heat_score:</b>`);
    top5.forEach((e, i) => {
      const star = i === 0 ? '⭐ ' : '';
      lines.push(`${i + 1}. ${star}${escapeHtml(e.source_title)}  (${fmtScore(e.heat_score)})`);
    });
  }
  lines.push('');
  lines.push('<i>Pick one — writes to drop_shadow_log.operator_pick.</i>');
  return lines.join('\n');
}

export function buildInlineKeyboard(
  dropDate: string,
  top5: ShadowTopEntry[],
  realDropTopicId: string | null,
): InlineKeyboardButton[][] {
  const rows: InlineKeyboardButton[][] = [];
  const topRow: InlineKeyboardButton[] = [];
  top5.forEach((e, i) => {
    const label = i === 0 ? '⭐ #1' : `${i + 1}`;
    topRow.push({ text: label, callback_data: `pick:v1:${dropDate}:${e.candidate_id}` });
  });
  if (topRow.length > 0) rows.push(topRow);
  if (realDropTopicId !== null) {
    rows.push([
      {
        text: '📰 Actual Drop',
        callback_data: `drop:v1:${dropDate}:${realDropTopicId}`,
      },
    ]);
  }
  rows.push([{ text: '⏭ Skip', callback_data: `skip:v1:${dropDate}` }]);
  return rows;
}

async function fetchJsonWithTimeout(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; message_id: number | null }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
  });
  try {
    const res = (await Promise.race([
      fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      timeout,
    ])) as Response;
    if (!res.ok) return { ok: false, status: res.status, message_id: null };
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      return { ok: false, status: res.status, message_id: null };
    }
    const message_id =
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { result?: { message_id?: unknown } }).result?.message_id === 'number'
        ? ((parsed as { result: { message_id: number } }).result.message_id as number)
        : null;
    return { ok: true, status: res.status, message_id };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function emittedAtFromRow(row: ScheduledJobRow): string | undefined {
  const v = row.payload.emitted_at;
  return typeof v === 'string' ? v : undefined;
}

async function stampPayload(
  deps: Parameters<JobHandler>[1],
  rowId: string,
  payload: StampPayload,
): Promise<void> {
  const update: ScheduledJobsUpdate = {
    payload: payload as unknown as ScheduledJobsUpdate['payload'],
  };
  const { error } = await deps.supabase.from('scheduled_jobs').update(update).eq('id', rowId);
  if (error) {
    deps.logger.debug({
      event: 'telegram_digest_send.stamp_payload_failed',
      message: scrubMessage(error.message),
    });
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export function buildTelegramDigestSendHandler(opts?: {
  readonly now?: () => Date;
  readonly envProvider?: () => Env;
  readonly fetchImpl?: typeof globalThis.fetch;
}): JobHandler {
  const now = opts?.now ?? (() => new Date());
  const envProvider = opts?.envProvider ?? loadEnv;
  return async function telegramDigestSendHandler(row: ScheduledJobRow, deps): Promise<void> {
    const env = envProvider();
    const dropDate = digestDate(now());

    if (!env.TELEGRAM_DIGEST_ENABLED) {
      await stampPayload(deps, row.id, {
        emitted_at: emittedAtFromRow(row),
        outcome: 'disabled',
        drop_date: dropDate,
      });
      deps.logger.info({
        event: 'telegram_digest_send.disabled',
        jobId: row.id,
        drop_date: dropDate,
      });
      return;
    }

    // 1. Read the shadow log row for this day. The generator (cron
    //    0 6 * * *) writes it 5 minutes before this handler fires;
    //    if it's missing, the generator didn't run or failed — stamp
    //    no_shadow_row and bail out.
    const { data: logRow, error: logErr } = await deps.supabase
      .from('drop_shadow_log')
      .select('drop_date, real_drop_topic_id, shadow_top_5')
      .eq('drop_date', dropDate)
      .maybeSingle();
    if (logErr) {
      await stampPayload(deps, row.id, {
        emitted_at: emittedAtFromRow(row),
        outcome: 'degraded_db',
        drop_date: dropDate,
        reason: scrubMessage(logErr.message).slice(0, 256),
      });
      deps.logger.warn({
        event: 'telegram_digest_send.log_load_failed',
        message: scrubMessage(logErr.message),
      });
      return;
    }
    if (!logRow) {
      await stampPayload(deps, row.id, {
        emitted_at: emittedAtFromRow(row),
        outcome: 'no_shadow_row',
        drop_date: dropDate,
      });
      deps.logger.warn({
        event: 'telegram_digest_send.no_shadow_row',
        jobId: row.id,
        drop_date: dropDate,
      });
      return;
    }
    const shadow = logRow as unknown as ShadowLogRow;
    const rawTop5 = (shadow.shadow_top_5 as unknown) ?? [];
    const top5 = Array.isArray(rawTop5) ? (rawTop5 as ShadowTopEntry[]) : [];

    // 2. Resolve candidate headlines + the actual-Drop headline. The
    //    source_title in shadow_top_5 is already the candidate
    //    headline — no second lookup needed for them. For the actual
    //    Drop we read news_topics.headline.
    let realDropHeadline: string | null = null;
    if (shadow.real_drop_topic_id) {
      const { data: topicRow } = await deps.supabase
        .from('news_topics')
        .select('headline')
        .eq('id', shadow.real_drop_topic_id)
        .maybeSingle();
      realDropHeadline = topicRow?.headline ?? null;
    }

    // 3. Build message + keyboard. The "📰 Actual Drop" button is
    //    always offered when real_drop_topic_id is present — the
    //    operator sees the headline in the message body and can
    //    decide whether it was already one of the top-5 picks.
    const text = buildMessageText(dropDate, realDropHeadline, top5);
    const keyboard = buildInlineKeyboard(dropDate, top5, shadow.real_drop_topic_id);

    // 5. POST to Telegram. URL carries the bot token — never logged.
    const url = `${TELEGRAM_API_BASE}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
    const fetchImpl = opts?.fetchImpl ?? deps.fetch ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new Error('telegram_digest_send: no fetch implementation available');
    }
    let send: Awaited<ReturnType<typeof fetchJsonWithTimeout>>;
    try {
      send = await fetchJsonWithTimeout(
        fetchImpl,
        url,
        {
          chat_id: env.TELEGRAM_CHAT_ID,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: { inline_keyboard: keyboard },
        },
        FETCH_TIMEOUT_MS,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'send_error';
      const reason = msg === 'timeout' ? 'timeout' : 'network';
      await stampPayload(deps, row.id, {
        emitted_at: emittedAtFromRow(row),
        outcome: 'degraded_send',
        drop_date: dropDate,
        reason,
      });
      deps.logger.warn({
        event: 'telegram_digest_send.network_failed',
        reason,
      });
      return;
    }
    if (!send.ok) {
      await stampPayload(deps, row.id, {
        emitted_at: emittedAtFromRow(row),
        outcome: 'degraded_send',
        drop_date: dropDate,
        reason: `status=${send.status}`,
      });
      deps.logger.warn({
        event: 'telegram_digest_send.http_failed',
        status: send.status,
      });
      return;
    }

    await stampPayload(deps, row.id, {
      emitted_at: emittedAtFromRow(row),
      outcome: 'ok',
      drop_date: dropDate,
      telegram_message_id: send.message_id ?? undefined,
    });
    deps.logger.info({
      event: 'telegram_digest_send.ok',
      jobId: row.id,
      drop_date: dropDate,
      telegram_message_id: send.message_id,
    });
  };
}

export const telegramDigestSendHandler: JobHandler = buildTelegramDigestSendHandler();
