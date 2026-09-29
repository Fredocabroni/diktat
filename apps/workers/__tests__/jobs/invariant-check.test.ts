// TS handler test for the invariant monitor.
// -----------------------------------------
// Runs the handler end-to-end against a real Postgres (local supabase stack
// in dev, service-container in CI). Each test opens a raw pg client, BEGINs a
// transaction, seeds fixtures, calls the handler with a `withPgClient` that
// hands over the SAME transaction-scoped client, asserts on the alerter spy,
// and ROLLBACKs.
//
// Gating:
//   TEST_DATABASE_URL unset               → skip (regular CI, no db).
//   TEST_DATABASE_URL unset + DB_REQUIRED → FAIL loud. Set by migrations.yml.
//
// The rule from PR spec: in regular CI it's fine to skip; inside the DB job
// a missing TEST_DATABASE_URL must never look like "green because empty".

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';

import { buildInvariantCheckHandler, type WithPgClient } from '../../src/jobs/invariant-check.js';
import type { Alerter } from '@diktat/shared/alerts';
import type { ScheduledJobRow } from '../../src/jobs/scheduler.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const DB_REQUIRED = process.env.DIKTAT_DB_TESTS_REQUIRED === '1';

if (!TEST_DATABASE_URL && DB_REQUIRED) {
  throw new Error(
    'DIKTAT_DB_TESTS_REQUIRED=1 but TEST_DATABASE_URL is unset. ' +
      'The migrations.yml job MUST set TEST_DATABASE_URL — a missing value here ' +
      'would silently skip the DB-backed tests, exactly the silent-CI failure ' +
      'the invariant monitor exists to catch.',
  );
}

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

// ─── Helpers ───────────────────────────────────────────────────────────────

interface AlertSpy {
  readonly alerter: Alerter;
  readonly calls: Array<{ severity: string; title: string; detail: string }>;
}

function makeAlertSpy(): AlertSpy {
  const calls: AlertSpy['calls'] = [];
  const alerter: Alerter = {
    enabled: true,
    alert: async (severity, title, detail) => {
      calls.push({ severity, title, detail });
    },
  };
  return { alerter, calls };
}

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function buildRow(overrides: Partial<ScheduledJobRow> = {}): ScheduledJobRow {
  return {
    id: '00000000-0000-4000-8000-000000000000',
    job_type: 'invariant_check',
    idempotency_key: 'test',
    target_user_id: null,
    payload: {},
    status: 'processing',
    attempts: 1,
    max_attempts: 5,
    available_at: new Date().toISOString(),
    locked_at: new Date().toISOString(),
    locked_by: 'test',
    last_error: null,
    processed_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// The scheduler contract passes a supabase client + logger. Our handler only
// needs the logger; supply a bare stub for the type.
const bareHandlerDeps = {
  supabase: {} as never,
  logger: silentLogger,
};

// ─── Suite ─────────────────────────────────────────────────────────────────

describeDb('invariant-check handler', () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  // Wrap every test in BEGIN/ROLLBACK so fixtures never persist and tests
  // never see each other's rows.
  beforeEach(async () => {
    // If a previous test aborted mid-txn, roll back before starting a new one.
    try {
      await client.query('ROLLBACK');
    } catch {
      /* no-op: nothing to roll back */
    }
    await client.query('BEGIN');
  });

  // ─── Q1: battle_settled_missing_ap ────────────────────────────────────

  describe('Q1 · battle_settled_missing_ap', () => {
    async function seedUsers(): Promise<void> {
      await client.query(
        `insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at) values
          ('00000000-0000-0000-0000-000000000000', 'a1000001-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'ts-iq1-w@test.local', now(), now()),
          ('00000000-0000-0000-0000-000000000000', 'b1000001-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'ts-iq1-l@test.local', now(), now())`,
      );
    }

    it('BAD-1: settled+winner+no-ledger triggers Q1', async () => {
      await seedUsers();
      await client.query(
        `insert into public.battles (id, mode, status, winner_user_id, started_at, ended_at)
         values ($1, 'trivia', 'settled', $2, now() - interval '30 min', now() - interval '10 min')`,
        ['bb100001-0000-0000-0000-000000000001', 'a1000001-0000-0000-0000-000000000001'],
      );

      const spy = makeAlertSpy();
      const withPgClient: WithPgClient = async (fn) => fn(client);
      const handler = buildInvariantCheckHandler({
        withPgClient,
        alerter: spy.alerter,
        logger: silentLogger,
      });

      await handler(
        buildRow({ payload: { check_name: 'battle_settled_missing_ap' } }),
        bareHandlerDeps,
      );

      expect(spy.calls).toHaveLength(1);
      expect(spy.calls[0]!.severity).toBe('warn');
      expect(spy.calls[0]!.title).toBe('[invariant] battle_settled_missing_ap: 1 violations');
      expect(spy.calls[0]!.detail).toContain('bb100001-0000-0000-0000-000000000001');
    });

    it('LEGIT-null-winner stays silent', async () => {
      await seedUsers();
      await client.query(
        `insert into public.battles (id, mode, status, winner_user_id, started_at, ended_at)
         values ($1, 'open_debate', 'settled', null, now() - interval '30 min', now() - interval '10 min')`,
        ['bb100001-0000-0000-0000-000000000002'],
      );

      const spy = makeAlertSpy();
      const handler = buildInvariantCheckHandler({
        withPgClient: async (fn) => fn(client),
        alerter: spy.alerter,
        logger: silentLogger,
      });

      await handler(
        buildRow({ payload: { check_name: 'battle_settled_missing_ap' } }),
        bareHandlerDeps,
      );

      expect(spy.calls).toHaveLength(0);
    });

    it('LEGIT-within-grace stays silent (<5 min)', async () => {
      await seedUsers();
      await client.query(
        `insert into public.battles (id, mode, status, winner_user_id, started_at, ended_at)
         values ($1, 'trivia', 'settled', $2, now() - interval '20 min', now() - interval '1 min')`,
        ['bb100001-0000-0000-0000-000000000004', 'a1000001-0000-0000-0000-000000000001'],
      );

      const spy = makeAlertSpy();
      const handler = buildInvariantCheckHandler({
        withPgClient: async (fn) => fn(client),
        alerter: spy.alerter,
        logger: silentLogger,
      });

      await handler(
        buildRow({ payload: { check_name: 'battle_settled_missing_ap' } }),
        bareHandlerDeps,
      );

      expect(spy.calls).toHaveLength(0);
    });

    it('LEGIT-correctly-settled via apply_ap_drafts stays silent', async () => {
      await seedUsers();
      await client.query(
        `insert into public.battles (id, mode, status, winner_user_id, started_at, ended_at)
         values ($1, 'trivia', 'settled', $2, now() - interval '20 min', now() - interval '10 min')`,
        ['bb100001-0000-0000-0000-000000000005', 'a1000001-0000-0000-0000-000000000001'],
      );
      await client.query(
        `select public.apply_ap_drafts(jsonb_build_array(
          jsonb_build_object(
            'user_id', $1::text, 'delta', 10, 'reason', 'battle_win',
            'ref_type', 'battle', 'ref_id', $2::text,
            'idempotency_key', 'ts:iq1:correct:win', 'is_practice', false
          ),
          jsonb_build_object(
            'user_id', $3::text, 'delta', -10, 'reason', 'battle_loss',
            'ref_type', 'battle', 'ref_id', $2::text,
            'idempotency_key', 'ts:iq1:correct:loss', 'is_practice', false
          )
        ))`,
        [
          'a1000001-0000-0000-0000-000000000001',
          'bb100001-0000-0000-0000-000000000005',
          'b1000001-0000-0000-0000-000000000002',
        ],
      );

      const spy = makeAlertSpy();
      const handler = buildInvariantCheckHandler({
        withPgClient: async (fn) => fn(client),
        alerter: spy.alerter,
        logger: silentLogger,
      });

      await handler(
        buildRow({ payload: { check_name: 'battle_settled_missing_ap' } }),
        bareHandlerDeps,
      );

      expect(spy.calls).toHaveLength(0);
    });

    it('LEGIT-ghost-credit-only stays silent (any ledger row counts)', async () => {
      await seedUsers();
      await client.query(
        `insert into public.battles (id, mode, status, winner_user_id, started_at, ended_at)
         values ($1, 'trivia', 'settled', $2, now() - interval '20 min', now() - interval '10 min')`,
        ['bb100001-0000-0000-0000-000000000006', 'a1000001-0000-0000-0000-000000000001'],
      );
      await client.query(
        `select public.apply_ap_drafts(jsonb_build_array(
          jsonb_build_object(
            'user_id', $1::text, 'delta', 0, 'reason', 'ghost_credit',
            'ref_type', 'battle', 'ref_id', $2::text,
            'idempotency_key', 'ts:iq1:ghost:only', 'is_practice', false
          )
        ))`,
        ['a1000001-0000-0000-0000-000000000001', 'bb100001-0000-0000-0000-000000000006'],
      );

      const spy = makeAlertSpy();
      const handler = buildInvariantCheckHandler({
        withPgClient: async (fn) => fn(client),
        alerter: spy.alerter,
        logger: silentLogger,
      });

      await handler(
        buildRow({ payload: { check_name: 'battle_settled_missing_ap' } }),
        bareHandlerDeps,
      );

      expect(spy.calls).toHaveLength(0);
    });

    it('overflow signals "6+" and lists 5 ids + "1+ more"', async () => {
      await seedUsers();
      const ids = [1, 2, 3, 4, 5, 6, 7].map(
        (i) => `bb100001-0000-0000-0000-0000000000${i.toString(16).padStart(2, '0')}`,
      );
      for (const id of ids) {
        await client.query(
          `insert into public.battles (id, mode, status, winner_user_id, started_at, ended_at)
           values ($1, 'trivia', 'settled', $2, now() - interval '30 min', now() - interval '10 min')`,
          [id, 'a1000001-0000-0000-0000-000000000001'],
        );
      }

      const spy = makeAlertSpy();
      const handler = buildInvariantCheckHandler({
        withPgClient: async (fn) => fn(client),
        alerter: spy.alerter,
        logger: silentLogger,
      });

      await handler(
        buildRow({ payload: { check_name: 'battle_settled_missing_ap' } }),
        bareHandlerDeps,
      );

      expect(spy.calls).toHaveLength(1);
      expect(spy.calls[0]!.title).toBe('[invariant] battle_settled_missing_ap: 6+ violations');
      // Body: exactly 5 ids + trailing "+ 1+ more".
      const lines = spy.calls[0]!.detail.split('\n');
      expect(lines).toHaveLength(6);
      expect(lines[5]).toBe('+ 1+ more');
    });
  });

  // ─── Q2: prediction_missing_stake ─────────────────────────────────────

  describe('Q2 · prediction_missing_stake', () => {
    async function seedFixtures(): Promise<void> {
      await client.query(
        `insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at) values
          ('00000000-0000-0000-0000-000000000000', 'a2000001-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'ts-iq2-a@test.local', now(), now()),
          ('00000000-0000-0000-0000-000000000000', 'b2000001-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'ts-iq2-b@test.local', now(), now())`,
      );
      await client.query(
        `update public.users set current_ap = 500 where id in (
          'a2000001-0000-0000-0000-000000000001',
          'b2000001-0000-0000-0000-000000000002'
        )`,
      );
      await client.query(
        `insert into public.news_topics (id, slug, headline) values
          ('d2000000-0000-4000-8000-000000000001', 'ts-iq2-topic', 'TS test topic')`,
      );
    }

    it('BAD-1: prediction with no ledger triggers Q2', async () => {
      await seedFixtures();
      await client.query(
        `insert into public.predictions (id, topic_id, user_id, direction, ap_stake, status)
         values ($1, 'd2000000-0000-4000-8000-000000000001', $2, 'yes', 25, 'open')`,
        ['ee200001-0000-0000-0000-000000000001', 'a2000001-0000-0000-0000-000000000001'],
      );

      const spy = makeAlertSpy();
      const handler = buildInvariantCheckHandler({
        withPgClient: async (fn) => fn(client),
        alerter: spy.alerter,
        logger: silentLogger,
      });

      await handler(
        buildRow({ payload: { check_name: 'prediction_missing_stake' } }),
        bareHandlerDeps,
      );

      expect(spy.calls).toHaveLength(1);
      expect(spy.calls[0]!.severity).toBe('warn');
      expect(spy.calls[0]!.title).toBe('[invariant] prediction_missing_stake: 1 violations');
    });

    it('BAD-wrong-user (stake_row.user_id != prediction.user_id) triggers Q2', async () => {
      await seedFixtures();
      await client.query(
        `insert into public.predictions (id, topic_id, user_id, direction, ap_stake, status)
         values ($1, 'd2000000-0000-4000-8000-000000000001', $2, 'yes', 25, 'open')`,
        ['ee200001-0000-0000-0000-000000000002', 'a2000001-0000-0000-0000-000000000001'],
      );
      await client.query(
        `insert into public.ap_transactions (
          user_id, delta, balance_after, reason, ref_type, ref_id, idempotency_key
        ) values (
          'b2000001-0000-0000-0000-000000000002',
          -25, 475, 'prediction_stake', 'prediction', $1, 'ts:iq2:wrong-user'
        )`,
        ['ee200001-0000-0000-0000-000000000002'],
      );

      const spy = makeAlertSpy();
      const handler = buildInvariantCheckHandler({
        withPgClient: async (fn) => fn(client),
        alerter: spy.alerter,
        logger: silentLogger,
      });

      await handler(
        buildRow({ payload: { check_name: 'prediction_missing_stake' } }),
        bareHandlerDeps,
      );

      expect(spy.calls).toHaveLength(1);
      expect(spy.calls[0]!.detail).toContain('ee200001-0000-0000-0000-000000000002');
    });

    it('BAD-wrong-debit (delta != -ap_stake) triggers Q2', async () => {
      await seedFixtures();
      await client.query(
        `insert into public.predictions (id, topic_id, user_id, direction, ap_stake, status)
         values ($1, 'd2000000-0000-4000-8000-000000000001', $2, 'yes', 25, 'open')`,
        ['ee200001-0000-0000-0000-000000000003', 'a2000001-0000-0000-0000-000000000001'],
      );
      await client.query(
        `insert into public.ap_transactions (
          user_id, delta, balance_after, reason, ref_type, ref_id, idempotency_key
        ) values (
          'a2000001-0000-0000-0000-000000000001',
          -10, 490, 'prediction_stake', 'prediction', $1, 'ts:iq2:wrong-debit'
        )`,
        ['ee200001-0000-0000-0000-000000000003'],
      );

      const spy = makeAlertSpy();
      const handler = buildInvariantCheckHandler({
        withPgClient: async (fn) => fn(client),
        alerter: spy.alerter,
        logger: silentLogger,
      });

      await handler(
        buildRow({ payload: { check_name: 'prediction_missing_stake' } }),
        bareHandlerDeps,
      );

      expect(spy.calls).toHaveLength(1);
    });

    it('LEGIT-correct via place_prediction stays silent', async () => {
      await seedFixtures();
      // Simulate an authenticated request as user A; place_prediction reads
      // auth.uid() → jwt.claims.sub. `set local` scopes to this txn.
      await client.query(`SET LOCAL role authenticated`);
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({
          sub: 'a2000001-0000-0000-0000-000000000001',
          role: 'authenticated',
        }),
      ]);
      await client.query(`SELECT public.place_prediction($1::uuid, $2::text, $3::int, null)`, [
        'd2000000-0000-4000-8000-000000000001',
        'no',
        50,
      ]);
      // Reset the request context so the invariant query runs as postgres.
      // NOTE (round-1 security-review finding 6): `SET LOCAL role` above is
      // txn-scoped and would revert automatically at the beforeEach ROLLBACK,
      // so this `RESET ROLE` is defence-in-depth for readability, not the
      // load-bearing cleanup. Any future variant that switches to a session-
      // scoped `SET ROLE` (not `SET LOCAL`) MUST also install a matching
      // `RESET ROLE` in `afterEach` — otherwise the next test would inherit
      // the authenticated role and RLS would silently suppress rows.
      await client.query(`RESET ROLE`);
      await client.query(`SELECT set_config('request.jwt.claims', '', true)`);

      const spy = makeAlertSpy();
      const handler = buildInvariantCheckHandler({
        withPgClient: async (fn) => fn(client),
        alerter: spy.alerter,
        logger: silentLogger,
      });

      await handler(
        buildRow({ payload: { check_name: 'prediction_missing_stake' } }),
        bareHandlerDeps,
      );

      expect(spy.calls).toHaveLength(0);
    });

    it('LEGIT-outside-window (created 8d ago) stays silent', async () => {
      await seedFixtures();
      await client.query(
        `insert into public.predictions (id, topic_id, user_id, direction, ap_stake, status, created_at, updated_at)
         values ($1, 'd2000000-0000-4000-8000-000000000001', $2, 'yes', 25, 'open',
                 now() - interval '8 days', now() - interval '8 days')`,
        ['ee200001-0000-0000-0000-000000000005', 'a2000001-0000-0000-0000-000000000001'],
      );

      const spy = makeAlertSpy();
      const handler = buildInvariantCheckHandler({
        withPgClient: async (fn) => fn(client),
        alerter: spy.alerter,
        logger: silentLogger,
      });

      await handler(
        buildRow({ payload: { check_name: 'prediction_missing_stake' } }),
        bareHandlerDeps,
      );

      expect(spy.calls).toHaveLength(0);
    });
  });

  // ─── Query failure → error alert ──────────────────────────────────────

  it('query failure alerts at error severity (never silent)', async () => {
    // Force a query error by breaking one of the referenced tables mid-txn.
    // Statement timeout also exercises this path, but a rename is easier.
    await client.query(`ALTER TABLE public.battles RENAME TO _battles_broken`);

    const spy = makeAlertSpy();
    const handler = buildInvariantCheckHandler({
      withPgClient: async (fn) => fn(client),
      alerter: spy.alerter,
      logger: silentLogger,
    });

    await handler(
      buildRow({ payload: { check_name: 'battle_settled_missing_ap' } }),
      bareHandlerDeps,
    );

    // Exactly one alert; error severity; title names the check.
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.severity).toBe('error');
    expect(spy.calls[0]!.title).toContain('battle_settled_missing_ap');
    expect(spy.calls[0]!.title).toContain('query error');
  });
});

// Note: no separate "pure" unit tests for RESULT_LIMIT / IDS_IN_ALERT /
// enum bindings — round-1 security review (finding 4) asked us to keep
// the SQL query strings and their sibling module internals from being
// re-exported for external discovery. The overflow assertion in the
// DB-backed suite above already proves the RESULT_LIMIT ("6+") and
// IDS_IN_ALERT (5 ids + trailer) invariants; the enum bindings are
// compile-time guaranteed by the imports in
// `apps/workers/src/jobs/invariant-check.ts`.

// ─── Connection-error routing ──────────────────────────────────────────────
// Runs in every CI — no DB required. Uses a synthetic throwing withPgClient
// that mimics a pg connection error and asserts the handler routes it to
// error-severity alert with the correct title. Credential scrubbing is now
// performed inside the alerter (see packages/shared/src/__tests__/alerts.test.ts).

describe('invariant-check · connection-error routing', () => {
  it('routes withPgClient failure to error-severity alert with db_connection_error title', async () => {
    const spy = makeAlertSpy();
    const throwingPgClient: WithPgClient = async () => {
      throw new Error(
        'could not connect to server: connect ECONNREFUSED — ' +
          'postgresql://root:hunter2@db.internal:5432/diktat',
      );
    };
    const handler = buildInvariantCheckHandler({
      withPgClient: throwingPgClient,
      alerter: spy.alerter,
      logger: silentLogger,
    });

    await handler(
      buildRow({ payload: { check_name: 'battle_settled_missing_ap' } }),
      bareHandlerDeps,
    );

    expect(spy.calls).toHaveLength(1);
    const call = spy.calls[0]!;
    expect(call.severity).toBe('error');
    expect(call.title).toBe('[invariant] db_connection_error');
    // The handler hands the raw message to the alerter; the alerter scrubs
    // on the way out to Telegram (see @diktat/shared/alerts scrubMessage).
    // Spy captures pre-scrub args, so we only check routing here.
    expect(call.detail).toContain('ECONNREFUSED');
  });
});
