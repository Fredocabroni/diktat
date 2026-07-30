// Telegram alert helper — a factory whose config is injected (never reads
// process.env itself, so it's testable and env-agnostic). Each app constructs
// one at boot from its own env. Isomorphic-safe: no DOM/Node-fetch types are
// referenced (packages/shared compiles under `lib: ES2022` only), so `fetch` is
// reached via a locally-typed `FetchLike` off globalThis.
//
// Contract: alert() NEVER throws and NEVER blocks the caller's success path
// (fire-and-forget with `void`). When the bot token / chat id are absent the
// alerter is a no-op. Dedup + a global rate cap keep one bug from becoming a
// message storm. Failures are logged with a status/reason ONLY — never the bot
// token or the request URL (Telegram/Node error strings can embed the URL).

export type AlertSeverity = 'error' | 'warn' | 'info';

/** Coarse failure signal handed to `onFailure` — status/reason only, never token/url. */
export interface AlertFailure {
  readonly status: number | 'network' | 'timeout' | 'rate_limited';
  readonly severity: AlertSeverity;
}

/** Minimal fetch shape — avoids depending on DOM/Node-fetch lib types. */
type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number }>;

export interface AlerterConfig {
  readonly botToken?: string;
  readonly chatId?: string;
  readonly fetchImpl?: FetchLike;
  readonly now?: () => number;
  /**
   * Invoked on a send failure with a coarse status ONLY. Wire this to your
   * logger. MUST NOT be passed the token or URL — by contract this receives
   * just an HTTP status code or a reason word.
   */
  readonly onFailure?: (info: AlertFailure) => void;
  /** Per-dedupKey suppression window. Default 30 min. */
  readonly dedupTtlMs?: number;
  /** Global rate window + cap (storm guard). Defaults: 5 min / 15 alerts. */
  readonly rateWindowMs?: number;
  readonly rateMaxPerWindow?: number;
  /** Per-request timeout. Default 5s. */
  readonly timeoutMs?: number;
}

export interface Alerter {
  alert(
    severity: AlertSeverity,
    title: string,
    detail: string,
    opts?: { dedupKey?: string; dedupTtlMs?: number },
  ): Promise<void>;
  /** False when token/chatId absent — callers can log "alerts disabled" once. */
  readonly enabled: boolean;
}

const TELEGRAM_MAX = 4096;
const EMOJI: Record<AlertSeverity, string> = { error: '🔴', warn: '🟡', info: '🟢' };

/** Escape the three characters Telegram HTML parse_mode is strict about. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Clamp to Telegram's 4096-char limit WITHOUT cutting mid-entity/tag (a dangling
 * `&am` or `<b` would 400, and the catch would swallow it silently). Strips any
 * trailing partial HTML entity/tag from the cut point, then appends an ellipsis.
 */
export function clampToTelegram(text: string): string {
  if (text.length <= TELEGRAM_MAX) return text;
  const cut = text
    .slice(0, TELEGRAM_MAX - 1)
    .replace(/&[a-z]*$/i, '')
    .replace(/<[^>]*$/, '');
  return `${cut}…`;
}

export function makeAlerter(cfg: AlerterConfig = {}): Alerter {
  const fetchImpl: FetchLike =
    cfg.fetchImpl ?? (globalThis as unknown as { fetch: FetchLike }).fetch;
  const now = cfg.now ?? Date.now;
  const dedupTtlDefault = cfg.dedupTtlMs ?? 30 * 60_000;
  const rateWindowMs = cfg.rateWindowMs ?? 5 * 60_000;
  const rateMax = cfg.rateMaxPerWindow ?? 15;
  const timeoutMs = cfg.timeoutMs ?? 5_000;
  const enabled = Boolean(cfg.botToken && cfg.chatId);
  const onFailure = cfg.onFailure ?? (() => {});

  const lastSent = new Map<string, number>();
  let windowStart = now();
  let windowCount = 0;
  let suppressed = 0;

  async function post(text: string, severity: AlertSeverity): Promise<void> {
    // NB: the URL carries the bot token — it is built here and never logged.
    const url = `https://api.telegram.org/bot${cfg.botToken}/sendMessage`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    });
    try {
      const res = await Promise.race([
        fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: cfg.chatId,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          }),
        }),
        timeout,
      ]);
      if (!res.ok) onFailure({ status: res.status, severity });
    } catch (err) {
      // Never surface the error message/URL — only a coarse reason.
      const reason = err instanceof Error && err.message === 'timeout' ? 'timeout' : 'network';
      onFailure({ status: reason, severity });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async function alert(
    severity: AlertSeverity,
    title: string,
    detail: string,
    opts?: { dedupKey?: string; dedupTtlMs?: number },
  ): Promise<void> {
    try {
      if (!enabled) return;
      const t = now();

      // --- Synchronous critical section: mutate all shared counters here, with
      // NO `await` in between, so concurrent alert() microtasks can't interleave
      // across a yield and race past the rate cap. Only network posts (below)
      // await, and by then no shared state is touched.
      if (opts?.dedupKey) {
        const ttl = opts.dedupTtlMs ?? dedupTtlDefault;
        const last = lastSent.get(opts.dedupKey);
        if (last !== undefined && t - last < ttl) return;
        lastSent.set(opts.dedupKey, t);
      }

      // Window rollover: capture a suppression count to report, reset the window,
      // and prune expired dedup entries HERE (once per window) rather than on
      // every insert — bounds the eviction cost to the rollover cadence.
      let summaryCount = 0;
      if (t - windowStart > rateWindowMs) {
        summaryCount = suppressed;
        windowStart = t;
        windowCount = 0;
        suppressed = 0;
        for (const [k, v] of lastSent) if (t - v > dedupTtlDefault) lastSent.delete(k);
      }

      if (windowCount >= rateMax) {
        suppressed += 1;
        onFailure({ status: 'rate_limited', severity });
        return;
      }
      windowCount += 1;
      if (summaryCount > 0) windowCount += 1; // the summary itself counts toward the window

      // Pre-slice raw detail to bound work, escape, assemble, then clamp so the
      // final HTML can't exceed the limit or end on a partial entity/tag.
      const text = clampToTelegram(
        `${EMOJI[severity]} <b>${escapeHtml(title)}</b>\n${escapeHtml(detail.slice(0, TELEGRAM_MAX))}`,
      );
      // --- End critical section; only awaited network posts below.
      if (summaryCount > 0) {
        await post(
          `${EMOJI.warn} <b>alerts suppressed</b>\n${summaryCount} alert(s) rate-limited in the last window`,
          'warn',
        );
      }
      await post(text, severity);
    } catch {
      // alert() must NEVER throw — swallow anything unexpected.
    }
  }

  return { alert, enabled };
}
