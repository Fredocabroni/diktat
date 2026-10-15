-- Migration: #215 LOW 2 — host-format CHECK constraints on the three
-- GDELT cluster host columns.
--
-- Flagged in the #221 push-2 security review as LOW 2: the host
-- columns on `gdelt_event_cluster` (`primary_host`, `best_news_host`)
-- and `gdelt_event_cluster_outlet` (`host`) are TEXT with no shape
-- gate. `p_host` is derived from `normalizeHost(parsed.hostname)` at
-- the TypeScript boundary (lower-cased, www-stripped) so arbitrary
-- values cannot reach the DB in normal operation. But a host value
-- with embedded whitespace, a null byte, or a Unicode homoglyph would
-- be stored correctly and would deduplicate against the composite PK
-- `(global_event_id, host)` — producing phantom cluster rows invisible
-- to host-equality checks.
--
-- Fix: add a defense-in-depth regex CHECK on each column:
--   `host ~ '^[a-z0-9][a-z0-9.-]*[a-z0-9]$'`
--
-- Reads: lowercase alphanumeric at the start, alphanumeric / dot /
-- hyphen in the middle, lowercase alphanumeric at the end. Rejects
-- whitespace anywhere, null bytes, Unicode homoglyphs, uppercase
-- (the TS layer already lowercases via normalizeHost), and bare dots
-- / bare hyphens / empty strings.
--
-- This pattern is intentionally ASCII-only. All 30 outlets on the
-- current allowlist have ASCII hostnames (apnews.com, bbc.co.uk,
-- supremecourt.gov, etc.). Internationalized hostnames would need to
-- arrive in their ACE / xn-- form; a future allowlist addition for a
-- non-ASCII host would need to loosen this CHECK, so the regression
-- surfaces at the storage layer rather than silently drifting.
--
-- Prod violation counts (read-only pre-apply SELECT 2026-10-15 against
-- prod project ref immzaaysjlftyijwdsrm):
--   gdelt_event_cluster.primary_host:   0 non-matching / 0 non-null / 606 rows
--   gdelt_event_cluster.best_news_host: 0 non-matching / 41 non-null / 606 rows
--   gdelt_event_cluster_outlet.host:    0 non-matching / 615 non-null / 615 rows
-- Zero violations across all three columns → immediate validation
-- (no NOT VALID + VALIDATE split).
--
-- Prod max migration version confirmed read-only pre-apply:
--   20261018000000. New migration 20261022000000 sorts strictly after
--   the three queued migrations (20261019000000 PR C,
--   20261020000000 PR #231, 20261021000000 PR #233).
--
-- Up:
--   add constraint gdelt_event_cluster_primary_host_format check (
--     primary_host is null or primary_host ~ '^[a-z0-9][a-z0-9.-]*[a-z0-9]$'
--   );
--   add constraint gdelt_event_cluster_best_news_host_format check (
--     best_news_host ~ '^[a-z0-9][a-z0-9.-]*[a-z0-9]$'
--   );
--     — nullable column; standard Postgres CHECK NULL semantics skip
--       NULL rows, so no explicit NULL branch written.
--   add constraint gdelt_event_cluster_outlet_host_format check (
--     host ~ '^[a-z0-9][a-z0-9.-]*[a-z0-9]$'
--   );
--     — NOT NULL column; no NULL branch needed.
--
-- Down:
--   alter table public.gdelt_event_cluster_outlet
--     drop constraint if exists gdelt_event_cluster_outlet_host_format;
--   alter table public.gdelt_event_cluster
--     drop constraint if exists gdelt_event_cluster_best_news_host_format;
--   alter table public.gdelt_event_cluster
--     drop constraint if exists gdelt_event_cluster_primary_host_format;

begin;

alter table public.gdelt_event_cluster
  add constraint gdelt_event_cluster_primary_host_format check (
    primary_host is null
    or primary_host ~ '^[a-z0-9][a-z0-9.-]*[a-z0-9]$'
  );

comment on constraint gdelt_event_cluster_primary_host_format
  on public.gdelt_event_cluster is
  'Defense-in-depth: primary_host must be null, or lowercase ASCII alphanumeric with dot/hyphen in the middle. Rejects whitespace, null bytes, Unicode homoglyphs. #215 LOW 2 (#221 push-2 security-reviewer).';

alter table public.gdelt_event_cluster
  add constraint gdelt_event_cluster_best_news_host_format check (
    best_news_host ~ '^[a-z0-9][a-z0-9.-]*[a-z0-9]$'
  );

comment on constraint gdelt_event_cluster_best_news_host_format
  on public.gdelt_event_cluster is
  'Defense-in-depth: when best_news_host is present, it must be lowercase ASCII alphanumeric with dot/hyphen in the middle. Null rows pass per standard Postgres CHECK semantics. #215 LOW 2.';

alter table public.gdelt_event_cluster_outlet
  add constraint gdelt_event_cluster_outlet_host_format check (
    host ~ '^[a-z0-9][a-z0-9.-]*[a-z0-9]$'
  );

comment on constraint gdelt_event_cluster_outlet_host_format
  on public.gdelt_event_cluster_outlet is
  'Defense-in-depth: host must be lowercase ASCII alphanumeric with dot/hyphen in the middle. Rejects whitespace, null bytes, Unicode homoglyphs. #215 LOW 2.';

commit;
