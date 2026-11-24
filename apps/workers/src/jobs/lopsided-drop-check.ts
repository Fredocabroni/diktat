// lopsided_drop_check handler.
//
// Scheduler spine fires every 30 min (migration 20261203000000). Each
// published Drop in the last 48h with lopsided_alert_sent_at NULL
// gets one scheduled_jobs row per (topic, 30-min bucket). This
// handler re-checks the current stance split via public.topic_stance_split
// and, if it crosses the "not much of a debate" threshold
// (>=20 locked votes AND one side >=85%), posts a single Telegram
// note to the operator chat and stamps news_topics.lopsided_alert_sent_at
// so no further rows match.
//
// Why re-check: the cron tick queues every candidate blindly. By the
// time the handler runs, the stance split may have shifted — so the
// handler is the authoritative gate, not the cron tick. The handler
// also serves as the dedupe boundary on parallel scheduler workers
// (two workers could both claim a row in the same 30-min bucket —
// the first stamp wins, the second re-reads and no-ops).
//
// Compliance: this is an operator-only Telegram message. It never
// reaches end users. No push, no in-app banner, nothing that could
// steer behaviour — it's a signal for Michael to know that the
// current Drop isn't landing as a debate.
//
// TELEGRAM_DIGEST_ENABLED gate is reused — operators who turn the
// digest off also don't want these notes. A disabled flag means the
// handler stamps `lopsided_alert_sent_at=now()` and returns, so the
// queue doesn't keep churning on the same Drops forever.

import { scrubMessage } from '@diktat/shared/alerts';

import { loadEnv } from '../env.js';
import type { JobHandler } from './scheduler.js';

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const FETCH_TIMEOUT_MS = 10_000;
const MIN_LOCKED_VOTES = 20;
const LOPSIDED_SIDE_THRESHOLD = 0.85;

interface LopsidedPayload {
  readonly topic_id?: string;
  readonly drop_date?: string;
}

interface StanceSplitRow {
  readonly agree_count: number | null;
  readonly disagree_count: number | null;
  readonly total: number | null;
  readonly early: boolean;
}

interface TopicRow {
  readonly id: string;
  readonly headline: string;
  readonly drop_at: string | null;
  readonly published_at: string | null;
  readonly is_drop: boolean;
  readonly lopsided_alert_sent_at: string | null;
}

export const lopsidedDropCheckHandler: JobHandler = async (row, deps) => {
  const payload = (row.payload ?? {}) as LopsidedPayload;
  if (!payload.topic_id) {
    throw new Error('lopsided_drop_check: payload.topic_id is required');
  }
  const env = loadEnv();

  // Load the topic. If it's already alerted or unpublished, no-op.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = deps.supabase as any;
  const { data: topic, error: topicErr } = (await supabase
    .from('news_topics')
    .select('id, headline, drop_at, published_at, is_drop, lopsided_alert_sent_at')
    .eq('id', payload.topic_id)
    .maybeSingle()) as {
    data: TopicRow | null;
    error: { message?: string } | null;
  };
  if (topicErr) {
    throw new Error(
      `lopsided_drop_check: topic read failed: ${scrubMessage(topicErr.message ?? '')}`,
    );
  }
  if (!topic) {
    deps.logger.info({ event: 'lopsided_drop_check.topic_missing', topic_id: payload.topic_id });
    return;
  }
  if (!topic.published_at || !topic.is_drop) {
    deps.logger.info({ event: 'lopsided_drop_check.unpublished', topic_id: payload.topic_id });
    return;
  }
  if (topic.lopsided_alert_sent_at !== null) {
    deps.logger.info({
      event: 'lopsided_drop_check.already_alerted',
      topic_id: payload.topic_id,
    });
    return;
  }

  // Re-check the stance split under the handler's own observation.
  const { data: splitRows, error: splitErr } = (await supabase.rpc('topic_stance_split', {
    p_topic_id: payload.topic_id,
  })) as { data: StanceSplitRow[] | StanceSplitRow | null; error: { message?: string } | null };
  if (splitErr) {
    throw new Error(
      `lopsided_drop_check: topic_stance_split failed: ${scrubMessage(splitErr.message ?? '')}`,
    );
  }
  const split: StanceSplitRow | null = Array.isArray(splitRows)
    ? (splitRows[0] ?? null)
    : splitRows;
  if (!split || split.early || split.total === null || split.total < MIN_LOCKED_VOTES) {
    deps.logger.info({
      event: 'lopsided_drop_check.below_threshold',
      topic_id: payload.topic_id,
      total: split?.total ?? null,
    });
    return;
  }
  const agree = split.agree_count ?? 0;
  const disagree = split.disagree_count ?? 0;
  const total = split.total;
  const topShare = Math.max(agree, disagree) / total;
  if (topShare < LOPSIDED_SIDE_THRESHOLD) {
    deps.logger.info({
      event: 'lopsided_drop_check.not_lopsided',
      topic_id: payload.topic_id,
      agree,
      disagree,
      total,
      top_share: Number(topShare.toFixed(2)),
    });
    return;
  }

  // Gate on TELEGRAM_DIGEST_ENABLED but still stamp the column so this
  // Drop stops churning through the queue. Same posture as the digest
  // handler when its flag is off.
  const sendEnabled = env.TELEGRAM_DIGEST_ENABLED;

  if (sendEnabled && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    const winner = agree > disagree ? 'agree' : 'disagree';
    const winnerCount = Math.max(agree, disagree);
    const pct = Math.round(topShare * 100);
    const dropDate = topic.drop_at
      ? new Intl.DateTimeFormat('en-CA', {
          timeZone: 'America/New_York',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(new Date(topic.drop_at))
      : (payload.drop_date ?? '');
    const text =
      `📉 <b>Not much of a debate · ${dropDate}</b>\n\n` +
      `${topic.headline}\n\n` +
      `<b>${winner.toUpperCase()}</b> ${winnerCount} / ${total} (${pct}%)` +
      ` · locked split\n\n` +
      `<i>Consider a tougher question tomorrow.</i>`;
    const url = `${TELEGRAM_API_BASE}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
    const fetchImpl = deps.fetch ?? globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const resp = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`telegram ${resp.status}: ${scrubMessage(body).slice(0, 200)}`);
      }
    } finally {
      clearTimeout(timer);
    }
  } else {
    deps.logger.info({
      event: 'lopsided_drop_check.telegram_disabled',
      topic_id: payload.topic_id,
    });
  }

  // Stamp after the send (or the skip) so another worker can't double-send.
  const { error: stampErr } = await supabase
    .from('news_topics')
    .update({ lopsided_alert_sent_at: new Date().toISOString() })
    .eq('id', payload.topic_id)
    .is('lopsided_alert_sent_at', null);
  if (stampErr) {
    throw new Error(`lopsided_drop_check: stamp failed: ${scrubMessage(stampErr.message ?? '')}`);
  }

  deps.logger.info({
    event: 'lopsided_drop_check.alerted',
    topic_id: payload.topic_id,
    total,
    agree,
    disagree,
    top_share: Number(topShare.toFixed(2)),
    sent: sendEnabled,
  });
};
