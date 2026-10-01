-- Migration: per-adapter liveness tracking for news_ingest.
-- Up:   create public.news_adapter_health with one row per adapter name;
--       the handler UPSERTs after each adapter.fetch (success or failure).
--       RLS enabled, no policies — service_role writes/reads; no client
--       access. The 24-hour-stale warn log is implemented in the handler
--       and reads from this table.
-- Down: drop table public.news_adapter_health;
--
-- Motivation. Phase-3 ops lost two days when the BLS feed looked "ingesting"
-- but was actually frozen on an off-week — the previous feed URL
-- (news_release.rss) stops advancing between labor-market releases. The
-- adapter's `fetched` count stayed non-zero (dedup suppressed everything)
-- so the newsgate looked healthy. This table records the last time each
-- adapter (a) succeeded at all, (b) produced a FRESH insert (i.e. at
-- least one candidate that passed the dedup check), (c) failed. A
-- scheduler-tick warn log fires when `last_fresh_insert_at` is older
-- than 24h, which would have caught the stale-feed condition.
--
-- Shape rationale.
--   - PK on `adapter` (text): each adapter is a singleton; the handler
--     UPSERTs on the name. No surrogate id — the registry name IS the
--     identity.
--   - `last_success_at` and `last_fresh_insert_at` are SEPARATE: a dead
--     feed can succeed (HTTP 200, well-formed RSS) but produce zero
--     fresh inserts because every item is already in the dedup table.
--     That's exactly the failure the 24h warn is designed to catch.
--   - `last_error_message` is text with a 4096-octet CHECK cap. Round-2
--     security-reviewer M2: the pg_net 10MB feed-body cap is on the
--     RSS fetch path, not on this write — a parser error on a
--     malformed XML or JSON feed can produce a tens-of-KB message
--     string that lands directly here. The cap keeps a pathological
--     error from inflating the row to pathological size; 4096 bytes
--     is well above any legitimate error prose we've seen and well
--     below "row explodes." Handler-side truncation (in the sibling
--     code PR #155) belt-and-suspenders this by capping with the same
--     limit before writing.
--   - `created_at` is schema-reviewer convention — every new public
--     table carries the "when did this row first appear" signal.
--     Defaulted at INSERT and never updated.
--   - `updated_at` is maintained by the handler (not a trigger) so the
--     code path owns the invariant and tests can assert against it
--     without needing a DB round-trip for the trigger.
--   - `adapter` is CHECK-constrained to `^[a-z0-9_]{1,64}$`. The handler
--     passes the adapter's registry name verbatim into the UPSERT; the
--     registry today is a hardcoded TS enum, but the CHECK pins the
--     invariant into the schema so a future runtime-driven registry
--     (plugin loader, DB-driven adapter list, YAML config) can't
--     silently introduce an adapter name with whitespace, slashes, or
--     punctuation that would complicate downstream dashboards, log
--     grepping, or admin-console linking. Round-3 security-reviewer
--     M2 on PR #154.

begin;

create table public.news_adapter_health (
  adapter text primary key
    check (adapter ~ '^[a-z0-9_]{1,64}$'),
  last_success_at timestamptz,
  last_fresh_insert_at timestamptz,
  last_fetched_count integer not null default 0,
  last_fresh_count integer not null default 0,
  last_error_at timestamptz,
  last_error_message text
    check (last_error_message is null or octet_length(last_error_message) <= 4096),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.news_adapter_health is
  'Per-adapter liveness snapshot for news_ingest. One row per adapter name. '
  'The handler UPSERTs on every tick; the 24h-dedup warn in '
  'apps/workers/src/jobs/news-ingest.ts reads from this table.';

comment on column public.news_adapter_health.last_success_at is
  'Last time adapter.fetch returned without throwing (any HTTP 2xx + parse '
  'success). Separate from last_fresh_insert_at: a dead feed can succeed '
  'at the fetch while producing zero fresh candidates.';

comment on column public.news_adapter_health.last_fresh_insert_at is
  'Last time the adapter produced ≥1 candidate that passed dedup (i.e. '
  'inserted into news_topics_candidates with no 23505 duplicate-URL '
  'collision). This is the primary 24-hour liveness signal.';

-- Enable RLS; no policies. service_role bypasses RLS (handler writes);
-- the authenticated role has no access, which is correct — this is
-- internal observability, not user-visible. A future admin dashboard
-- adds a scoped read policy when it's built.
alter table public.news_adapter_health enable row level security;

-- Belt-and-suspenders explicit REVOKE from client roles. RLS alone
-- blocks reads/writes to new tables for authenticated/anon, but
-- `alter default privileges` statements added later for a different
-- feature could silently open this table to a client role. Explicit
-- REVOKE on this table makes the intent part of the schema and
-- survives a later default-privileges change. Mirrors the pattern in
-- 20260616120000_drop_pipeline.sql on public.news_topics_candidates.
-- Round-1 security-reviewer finding 1 on PR #154.
revoke all on public.news_adapter_health from anon, authenticated;

commit;
