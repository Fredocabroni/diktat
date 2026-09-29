// Invariant monitor. Runs a small set of read-only correctness checks against
// the live DB and posts Telegram alerts when a violation is found. Two checks
// today:
//
//   battle_settled_missing_ap   — a settled battle with a non-null winner and
//                                  no ap_transactions row keyed to it (any reason).
//   prediction_missing_stake    — a prediction row without a matching
//                                  prediction_stake ledger row (staker + delta match).
//
// The handler binds the queries against the SHARED enums in
// `@diktat/shared/enums`, so a rename that touches the enum breaks the monitor
// at compile time. The writers themselves currently hardcode these strings
// (SQL literals inside apply_ap_drafts / place_prediction, TS literals in the
// battle-runner / open-debate-runner `.update({ status: 'settled' })` calls);
// that residual drift risk is documented on GH issue #125's sibling design
// note and tracked as a deprioritized follow-up.
//
// Column truth (ap_transactions has NO battle_id / prediction_id columns; the
// join is `(ref_type, ref_id)`):
//   apply_ap_drafts    →  supabase/migrations/20260713120000:132-150
//   place_prediction   →  supabase/migrations/20260729120000:122-133
//
// The handler NEVER throws. A check-query error is caught and re-emitted as an
// `error`-severity Telegram alert; the row marks `done` regardless. If we
// threw, the scheduler would back off and eventually dead-letter (silently, at
// `error` log level only, no Telegram), which is exactly the silent-failure
// mode the user asked us to close.

import type { Client } from 'pg';

import { makeAlerter, type Alerter } from '@diktat/shared/alerts';
import { BattleStatusSchema, ApReasonSchema } from '@diktat/shared';

import type { JobHandler, ScheduledJobRow } from './scheduler.js';

// ─── Enums bound at compile time (see file header) ─────────────────────────
const BATTLE_STATUS_SETTLED = BattleStatusSchema.enum.settled;
const AP_REASON_PREDICTION_STAKE = ApReasonSchema.enum.prediction_stake;

// ─── Query shapes ──────────────────────────────────────────────────────────
// Parameter binding, not string interpolation — enum values enter via `$1`
// so a rename of the exported enum key surfaces as a TS error before runtime.

/** Q1. Settled battles with no ledger row of any reason keyed to the battle.
 *  `winner_user_id IS NOT NULL` excludes legit null-winner ties. The 5-min
 *  grace matches the crash-retry window between apply_ap_drafts and the
 *  claim-guarded status flip (battle-runner.ts:562-586, open-debate-runner.ts:365-370).
 *  LIMIT 6 so we know "6+" vs a specific count. */
const SQL_BATTLE_SETTLED_MISSING_AP = `
  select b.id::text as id
  from public.battles b
  where b.status = $1
    and b.winner_user_id is not null
    and b.ended_at <= now() - interval '5 minutes'
    and b.ended_at >= now() - interval '7 days'
    and not exists (
      select 1 from public.ap_transactions t
      where t.ref_type = 'battle' and t.ref_id = b.id
    )
  order by b.ended_at desc
  limit 6
`;

/** Q2. Predictions with no matching prediction_stake ledger row from the same
 *  user, with the exact expected debit. place_prediction is atomic (single
 *  plpgsql function, everything under the caller's RPC txn), so no grace
 *  period. `ap_stake > 0` is defensive — the column CHECK already requires it. */
const SQL_PREDICTION_MISSING_STAKE = `
  select p.id::text as id
  from public.predictions p
  where p.created_at >= now() - interval '7 days'
    and p.ap_stake > 0
    and not exists (
      select 1 from public.ap_transactions t
      where t.ref_type = 'prediction'
        and t.ref_id   = p.id
        and t.reason   = $1
        and t.user_id  = p.user_id
        and t.delta    = -p.ap_stake
    )
  order by p.created_at desc
  limit 6
`;

export const CHECK_NAMES = ['battle_settled_missing_ap', 'prediction_missing_stake'] as const;
export type CheckName = (typeof CHECK_NAMES)[number];

interface CheckSpec {
  readonly name: CheckName;
  readonly sql: string;
  readonly params: readonly unknown[];
}

const CHECKS: readonly CheckSpec[] = [
  {
    name: 'battle_settled_missing_ap',
    sql: SQL_BATTLE_SETTLED_MISSING_AP,
    params: [BATTLE_STATUS_SETTLED],
  },
  {
    name: 'prediction_missing_stake',
    sql: SQL_PREDICTION_MISSING_STAKE,
    params: [AP_REASON_PREDICTION_STAKE],
  },
];

// ─── Runtime knobs ─────────────────────────────────────────────────────────
const STATEMENT_TIMEOUT_MS = 10_000;
const DEDUP_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const RESULT_LIMIT = 6; // matches LIMIT in every SQL_* above
const IDS_IN_ALERT = 5;

// Per-entity dedup: `invariant:<check_name>:<entity_id>` → expiresAt.
// In-process Map; worker restart resets (one duplicate alert per restart, acceptable).
export type DedupMap = Map<string, number>;

// ─── Client lifecycle DI seam ──────────────────────────────────────────────
/** A caller-provided function that yields a connected pg client for the
 *  duration of `fn` and is responsible for closing it. Runtime creates+ends
 *  a fresh client per invocation; tests hand in their transaction-scoped
 *  client and no-op the close so uncommitted fixtures are visible. */
export type WithPgClient = <T>(fn: (client: Client) => Promise<T>) => Promise<T>;

// ─── Alert formatting ──────────────────────────────────────────────────────

/** Build the alert body. "6+" when the LIMIT was hit; body lists first 5 IDs;
 *  footer says "+ K+ more" when truncated. No handles, no user_ids, no PII. */
export function formatViolationAlert(
  checkName: CheckName,
  ids: string[],
): {
  title: string;
  detail: string;
} {
  const overflow = ids.length >= RESULT_LIMIT;
  const shown = ids.slice(0, IDS_IN_ALERT);
  const countLabel = overflow ? `${IDS_IN_ALERT + 1}+` : String(ids.length);
  const title = `[invariant] ${checkName}: ${countLabel} violations`;
  const lines: string[] = [...shown];
  if (overflow) lines.push('+ 1+ more');
  return { title, detail: lines.join('\n') };
}

// ─── Core: run one check ───────────────────────────────────────────────────

interface RunOneOpts {
  readonly client: Client;
  readonly alerter: Alerter;
  readonly logger: Logger;
  readonly now: () => number;
  readonly dedup: DedupMap;
}

interface Logger {
  info: (obj: Record<string, unknown>) => void;
  warn: (obj: Record<string, unknown>) => void;
  error: (obj: Record<string, unknown>) => void;
}

async function runOneCheck(spec: CheckSpec, opts: RunOneOpts): Promise<void> {
  let rows: { id: string }[];
  try {
    const res = await opts.client.query<{ id: string }>(spec.sql, [...spec.params]);
    rows = res.rows;
  } catch (err) {
    // Never fail silently: a broken query MUST reach Telegram at error
    // severity. Then return; scheduler marks the row done and the next cron
    // cycle re-enqueues. If the query stays broken, every cycle re-alerts,
    // paced by the alerter's own 30-min dedup on this key.
    const message = err instanceof Error ? err.message : String(err);
    opts.logger.error({
      event: 'invariant_check.query_error',
      checkName: spec.name,
      message,
    });
    await opts.alerter.alert('error', `[invariant] ${spec.name}: query error`, message, {
      dedupKey: `invariant:query_error:${spec.name}`,
    });
    return;
  }

  opts.logger.info({
    event: 'invariant_check.result',
    checkName: spec.name,
    count: rows.length,
    truncated: rows.length >= RESULT_LIMIT,
  });

  if (rows.length === 0) return;

  // Per-entity dedup. Only alert on entities we haven't already surfaced
  // inside the TTL. If EVERY id is deduped, stay silent this tick.
  const now = opts.now();
  for (const [k, exp] of opts.dedup) {
    if (exp <= now) opts.dedup.delete(k);
  }

  const fresh: string[] = [];
  for (const row of rows) {
    const key = `invariant:${spec.name}:${row.id}`;
    if ((opts.dedup.get(key) ?? 0) > now) continue;
    fresh.push(row.id);
    opts.dedup.set(key, now + DEDUP_TTL_MS);
  }

  if (fresh.length === 0) {
    opts.logger.info({
      event: 'invariant_check.all_deduped',
      checkName: spec.name,
      count: rows.length,
    });
    return;
  }

  // Preserve the "6+" signal even when some ids are deduped: the count in
  // the header is fresh-only, but overflow flips true if the underlying
  // query returned the LIMIT. That's the honest read — "6+ violations,
  // showing N you haven't seen recently".
  const overflow = rows.length >= RESULT_LIMIT;
  const shown = fresh.slice(0, IDS_IN_ALERT);
  const countLabel = overflow ? `${IDS_IN_ALERT + 1}+` : String(fresh.length);
  const title = `[invariant] ${spec.name}: ${countLabel} violations`;
  const detailLines: string[] = [...shown];
  if (overflow && fresh.length > IDS_IN_ALERT) {
    detailLines.push(`+ ${fresh.length - IDS_IN_ALERT}+ more`);
  } else if (overflow) {
    detailLines.push('+ 1+ more');
  }

  await opts.alerter.alert('warn', title, detailLines.join('\n'), {
    // Per-tick dedup so the alerter's own 30-min TTL doesn't collapse two
    // different ticks with different id sets. Each fresh id in the alert is
    // already gated by the 6h per-entity Map above.
    dedupKey: `invariant:tick:${spec.name}:${shown.join(',')}`,
  });
}

// ─── Runner over the full check set ────────────────────────────────────────

export async function runInvariantChecks(opts: {
  readonly client: Client;
  readonly alerter: Alerter;
  readonly logger: Logger;
  readonly now?: () => number;
  readonly dedup: DedupMap;
  /** Optional filter, primarily for tests. */
  readonly only?: readonly CheckName[];
}): Promise<void> {
  // Bounded per-statement timeout, parameterised (never string-interpolated
  // — see security review round 1 finding 1) and transaction-local
  // (is_local=true, third arg) so the setting can never survive onto a
  // reused connection — see finding 2. Caller-contract: `opts.client` must
  // already be inside a transaction. Runtime `withFreshPgClient` opens a
  // BEGIN before invoking us; tests hold their own transaction open via
  // `beforeEach`. `set_config(is_local=true)` outside a txn silently degrades
  // to per-statement scope, which is fine but the contract above keeps it
  // predictable across future callers.
  await opts.client.query(`SELECT set_config($1, $2, true)`, [
    'statement_timeout',
    String(STATEMENT_TIMEOUT_MS),
  ]);

  const now = opts.now ?? Date.now;
  const filter = opts.only ? new Set<CheckName>(opts.only) : null;

  for (const spec of CHECKS) {
    if (filter && !filter.has(spec.name)) continue;
    await runOneCheck(spec, {
      client: opts.client,
      alerter: opts.alerter,
      logger: opts.logger,
      now,
      dedup: opts.dedup,
    });
  }
}

// ─── JobHandler adapter ────────────────────────────────────────────────────

/** Build the scheduler handler. Runtime wiring in `apps/workers/src/index.ts`
 *  supplies a `withPgClient` that opens a fresh Client per invocation and
 *  closes it in a `finally`. Tests pass a `withPgClient` that yields their
 *  own transaction-scoped Client and never closes it. */
export function buildInvariantCheckHandler(deps: {
  readonly withPgClient: WithPgClient;
  readonly alerter: Alerter;
  readonly logger: Logger;
  readonly now?: () => number;
  readonly dedup?: DedupMap;
}): JobHandler {
  const dedup = deps.dedup ?? new Map<string, number>();

  return async function invariantCheckHandler(row: ScheduledJobRow, handlerDeps): Promise<void> {
    // The scheduler passes a Supabase client; we don't use it here. Pull the
    // logger off the row/deps so multi-handler traces still tie back.
    const logger = handlerDeps?.logger ?? deps.logger;
    const payloadCheck = readCheckNameFromPayload(row.payload);

    try {
      await deps.withPgClient(async (client) => {
        await runInvariantChecks({
          client,
          alerter: deps.alerter,
          logger,
          now: deps.now,
          dedup,
          only: payloadCheck ? [payloadCheck] : undefined,
        });
      });
    } catch (err) {
      // Reaching here means withPgClient itself blew up (couldn't connect,
      // couldn't create a client). runOneCheck already catches per-query
      // errors above. Alert error-severity; mark done, don't dead-letter.
      const message = err instanceof Error ? err.message : String(err);
      logger.error({
        event: 'invariant_check.connection_error',
        message,
      });
      await deps.alerter.alert('error', '[invariant] db_connection_error', message, {
        dedupKey: 'invariant:connection_error',
      });
    }
  };
}

function readCheckNameFromPayload(payload: unknown): CheckName | undefined {
  if (payload == null || typeof payload !== 'object') return undefined;
  const p = payload as Record<string, unknown>;
  const v = p.check_name;
  if (typeof v !== 'string') return undefined;
  return (CHECK_NAMES as readonly string[]).includes(v) ? (v as CheckName) : undefined;
}

// ─── Runtime wiring helper ─────────────────────────────────────────────────

/** Build a `withPgClient` that opens a fresh `pg.Client` per invocation,
 *  runs `fn`, and closes it in a `finally`. Import inside so the pg import
 *  is inert in tests that stub `withPgClient`. */
export async function withFreshPgClient<T>(
  connectionString: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  // Lazy require: the file imports the type from 'pg' at the top for
  // signatures; the runtime constructor is imported at the call site so
  // tests can stub `withPgClient` without triggering pg native module load.
  const { Client } = await import('pg');
  const client = new Client({ connectionString });
  await client.connect();
  try {
    // Wrap the whole check-set in a transaction so `runInvariantChecks`'s
    // `set_config($, $, true)` binds tx-local — the setting is guaranteed to
    // die with the transaction, never leaking onto a reused connection even
    // if a future refactor points this at a shared pool. The checks are
    // read-only, so ROLLBACK is semantically equivalent to COMMIT; prefer
    // ROLLBACK so anything a check ever writes by accident is undone.
    await client.query('BEGIN READ ONLY');
    try {
      return await fn(client);
    } finally {
      await client.query('ROLLBACK');
    }
  } finally {
    await client.end();
  }
}

// No `__testing` re-export block. Motivation (round-1 security-review
// finding 4): the compiled production bundle must not surface the SQL
// query strings or module-internal knobs under a name an attacker with
// artifact-read access can discover. The DB-backed handler test at
// `apps/workers/__tests__/jobs/invariant-check.test.ts` proves the
// RESULT_LIMIT ("6+" title) and IDS_IN_ALERT (five-id body + trailer)
// behaviours via the overflow fixture, and the enum bindings above are
// compile-time guaranteed by the imports from `@diktat/shared`.

// Re-export the alerter factory so a caller wiring this handler in a
// non-standard place (e.g. a script) has one canonical import path.
export { makeAlerter };
