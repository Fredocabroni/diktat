// Zod-validated runtime env for the workers process. Parse once at boot.

import { z } from 'zod';

const boolFromString = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : v.toLowerCase() === 'true'));

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

    // Direct Postgres connection. The LISTEN/NOTIFY client uses this.
    DATABASE_URL: z.string().url(),

    // Service-role Supabase client for the wallet UPDATE.
    SUPABASE_URL: z.string().url(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

    // Upstash Redis (REST). Used as the cross-process cost-ledger sink for
    // ai-fabric and as the durable store for matchmaking sorted sets when
    // the matchmaking router lands (PR #17).
    UPSTASH_REDIS_REST_URL: z.string().url(),
    UPSTASH_REDIS_REST_TOKEN: z.string().min(1),

    // Privy. The flag must be 'true' AND both keys must be non-empty before
    // the listener actually calls the SDK; otherwise it logs a skip and
    // returns. Defense-in-depth so a misconfigured staging env can't half-
    // provision wallets.
    PRIVY_ENABLED: boolFromString.default(false),
    PRIVY_APP_ID: z.string().default(''),
    PRIVY_APP_SECRET: z.string().default(''),

    // VAPID — Web Push signing. All three vars must be non-empty before the
    // push_deliver handler actually dispatches; otherwise it logs a skip and
    // marks the row done with delivery_status='skipped_no_vapid'. Lets a dev
    // env without keys boot cleanly without dropping rows. Generated once via
    // `npx web-push generate-vapid-keys` and stored in env (NOT Postgres —
    // the private key never enters the database). Rotation: replace the pair,
    // redeploy workers; existing subscriptions fail next send with 401 and
    // soft-delete via the handler's disabled_reason='unauthorized' path.
    VAPID_PUBLIC_KEY: z.string().default(''),
    VAPID_PRIVATE_KEY: z.string().default(''),
    VAPID_SUBJECT: z.string().default(''),

    // GDELT trending-topic adapter (PR fix/gdelt-ingestor). The adapter is
    // registered in DEFAULT_ADAPTERS unconditionally, but its `fetch()` is
    // a no-op (returns []) unless this flag is true AND a GDELT API probe
    // has been proven locally against live GDELT first. Same gated-shadow-
    // ship pattern as PRIVY_ENABLED / FACT_CHECK_ENABLED. Keep false in
    // Railway until the operator top-ups Anthropic credits (so the full
    // enablement pipeline — including the AI prompts that consume GDELT
    // candidates — is observable end to end).
    GDELT_ENABLED: boolFromString.default(false),

    // Wikimedia pageviews validation collector. Public endpoint, no
    // auth; validation input only (never a primary heat source).
    // Defaults OFF.
    WIKIMEDIA_ENABLED: boolFromString.default(false),

    // Master heat-score gate. Defaults OFF. When off, every heat
    // collector/composer stamps outcome='disabled' and returns; the
    // walker's Drop-selection logic never reads heat_score.
    HEAT_ENABLED: boolFromString.default(false),

    // X v2 Trends-by-WOEID collector. Pay-per-use ($0.010/request).
    // Defaults OFF; handler fails closed with outcome='no_bearer' if
    // the flag is on but X_BEARER_TOKEN is empty. No live call tonight
    // — fixtures only per operator rules.
    X_TRENDS_ENABLED: boolFromString.default(false),
    X_BEARER_TOKEN: z.string().default(''),

    // Heat-signal collectors (plan v3). Each defaults OFF; the operator
    // flips them one at a time behind HEAT_ENABLED=false. When off, each
    // poller handler stamps outcome='disabled' and returns; the cron
    // keeps emitting rows so the queue drains cleanly.
    BLUESKY_ENABLED: boolFromString.default(false),

    // Telegram alerting (optional). Missing = alerter disabled — NEVER a boot
    // failure. Kept lenient (plain optional strings, no regex, unlike the api's
    // chat-id validation) precisely because the alerter is what REPORTS a boot
    // failure: it must never itself crash boot. The alerter reads these from
    // process.env directly (so it works even if this schema parse throws on some
    // other var); they are listed here for completeness + documentation.
    TELEGRAM_BOT_TOKEN: z.string().optional(),
    TELEGRAM_CHAT_ID: z.string().optional(),

    // Nightly shadow-digest delivery to Telegram. Shadow-only; the
    // operator reviews top-5 heat picks vs the walker's real Drop pick
    // via inline buttons, callback writes land in drop_shadow_log.
    //
    // Reuses the EXISTING alerter bot (TELEGRAM_BOT_TOKEN +
    // TELEGRAM_CHAT_ID). The long-poll loop (getUpdates) authorises
    // taps by:
    //   - DM chat (positive numeric TELEGRAM_CHAT_ID): require
    //     callback_query.from.id == TELEGRAM_CHAT_ID.
    //   - Group / channel (non-positive-numeric TELEGRAM_CHAT_ID):
    //     require TELEGRAM_OPERATOR_USER_ID set + from.id match.
    //     Without TELEGRAM_OPERATOR_USER_ID, every tap in the group
    //     is rejected (fail-closed).
    //
    // Defaults OFF; the superRefine below refuses to boot when the
    // flag is on without the credentials needed to authorise taps.
    TELEGRAM_DIGEST_ENABLED: boolFromString.default(false),
    TELEGRAM_OPERATOR_USER_ID: z.string().default(''),
  })
  .superRefine((env, ctx) => {
    // X_TRENDS_ENABLED=true without X_BEARER_TOKEN is a misconfiguration:
    // the handler's defensive no_bearer branch would catch it at runtime,
    // but a per-row stamp is a worse failure mode than refusing to boot.
    // Fail at env-parse time so the operator notices immediately rather
    // than discovering it in Axiom via a run of no_bearer stamps.
    if (env.X_TRENDS_ENABLED && env.X_BEARER_TOKEN.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['X_BEARER_TOKEN'],
        message: 'X_TRENDS_ENABLED=true requires a non-empty X_BEARER_TOKEN',
      });
    }
    // TELEGRAM_DIGEST_ENABLED=true demands the alerter bot's
    // credentials (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID) AND a
    // resolvable tap-authorisation path:
    //   - DM (TELEGRAM_CHAT_ID parses as a positive integer):
    //     the chat.id *is* the operator's user id, so no extra var
    //     is required — the gate uses it on both sides.
    //   - Group / channel (anything else, incl. negative supergroup
    //     ids and the empty string from an un-set var):
    //     require TELEGRAM_OPERATOR_USER_ID. The gate matches
    //     callback_query.from.id against it; the chat.id matches
    //     TELEGRAM_CHAT_ID.
    // A boot that cannot resolve BOTH credentials AND an operator
    // user id for a group chat fails here instead of silently
    // rejecting every tap at runtime.
    if (env.TELEGRAM_DIGEST_ENABLED) {
      if (!env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['TELEGRAM_BOT_TOKEN'],
          message: 'TELEGRAM_DIGEST_ENABLED=true requires a non-empty TELEGRAM_BOT_TOKEN',
        });
      }
      if (!env.TELEGRAM_CHAT_ID || env.TELEGRAM_CHAT_ID.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['TELEGRAM_CHAT_ID'],
          message: 'TELEGRAM_DIGEST_ENABLED=true requires a non-empty TELEGRAM_CHAT_ID',
        });
      } else {
        const chatIdInt = Number.parseInt(env.TELEGRAM_CHAT_ID, 10);
        const isDm =
          Number.isFinite(chatIdInt) &&
          chatIdInt > 0 &&
          String(chatIdInt) === env.TELEGRAM_CHAT_ID.trim();
        if (!isDm && env.TELEGRAM_OPERATOR_USER_ID.length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['TELEGRAM_OPERATOR_USER_ID'],
            message:
              'TELEGRAM_DIGEST_ENABLED=true with a group/channel TELEGRAM_CHAT_ID requires TELEGRAM_OPERATOR_USER_ID',
          });
        }
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

// Treat empty-string env vars as absent. Railway (and other platforms) can
// deliver a declared-but-unset variable as '' rather than omitting it — e.g. a
// partially-applied `[env] NODE_ENV=production` from railway.toml arriving blank.
// Zod .default()/.optional() only fire on `undefined`, so a blank value would
// otherwise hard-fail a defaulted enum (NODE_ENV='' → Invalid enum) or an
// optional regex at boot. '' == unset everywhere; a genuinely-required var that
// is blank still errors as Required.
function emptyToUndefined(source: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const key of Object.keys(source)) {
    const v = source[key];
    out[key] = v === '' ? undefined : v;
  }
  return out;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(emptyToUndefined(source));
  if (!parsed.success) {
    const formatted = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid env:\n${formatted}`);
  }
  return parsed.data;
}

export function privyReady(env: Env): boolean {
  return env.PRIVY_ENABLED && env.PRIVY_APP_ID.length > 0 && env.PRIVY_APP_SECRET.length > 0;
}

export function webPushReady(env: Env): boolean {
  return (
    env.VAPID_PUBLIC_KEY.length > 0 &&
    env.VAPID_PRIVATE_KEY.length > 0 &&
    env.VAPID_SUBJECT.length > 0
  );
}
