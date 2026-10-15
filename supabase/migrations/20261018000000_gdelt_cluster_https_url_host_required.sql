-- Migration: #220 security-reviewer LOWs 1 and 2 — strengthen the
-- https-URL CHECK patterns on gdelt_event_cluster.primary_url and
-- gdelt_event_cluster_outlet.url from `LIKE 'https://%'` to the
-- regex `^https://[^/\s]+` (requires at least one non-whitespace,
-- non-slash character after the scheme), and extend the same CHECK
-- to gdelt_event_cluster.best_news_url (deliberately excluded in
-- 20261017000000, flagged as LOW 2 for column-level symmetry).
--
-- Operator decision 2026-10-15 (PR #220 push-2 security-reviewer
-- "PASS with conditions"): the `LIKE 'https://%'` pattern accepts
-- degenerate values like `https://` (bare scheme) or
-- `https:// internal.svc/` (embedded whitespace). Both would satisfy
-- the CHECK while remaining SSRF-relevant if ever fetched. The only
-- writer today is the SECURITY DEFINER RPC upsert_gdelt_event_mention,
-- whose callers already pass requireHttpsUrl() + classifyUrl() — so
-- this is a storage-layer defense-in-depth tightening, not an active
-- bypass fix.
--
-- Prod violation count (read-only pre-apply SELECT 2026-10-15 against
-- prod project ref immzaaysjlftyijwdsrm):
--   gdelt_event_cluster.primary_url:     0 non-matching / 0 non-null / 546 rows
--   gdelt_event_cluster.best_news_url:   0 non-matching / 32 non-null / 546 rows
--   gdelt_event_cluster_outlet.url:      0 non-matching / 553 non-null / 553 rows
-- Zero violations across all three columns, so each regex CHECK
-- validates immediately (no NOT VALID + VALIDATE split needed).
--
-- Up:
--   drop constraint gdelt_event_cluster_primary_url_https on
--     public.gdelt_event_cluster;
--   add constraint gdelt_event_cluster_primary_url_https on
--     public.gdelt_event_cluster: primary_url IS NULL OR
--     primary_url ~ '^https://[^/\s]+'. The NULL branch is preserved
--     — primary_url is nullable until the first primary/direct
--     mention lands.
--   drop constraint gdelt_event_cluster_outlet_url_https on
--     public.gdelt_event_cluster_outlet;
--   add constraint gdelt_event_cluster_outlet_url_https on
--     public.gdelt_event_cluster_outlet: url ~ '^https://[^/\s]+'.
--     url is NOT NULL, no null branch needed.
--   add constraint gdelt_event_cluster_best_news_url_https on
--     public.gdelt_event_cluster: best_news_url ~ '^https://[^/\s]+'.
--     best_news_url is nullable; Postgres CHECK semantics skip NULL
--     rows per the SQL standard, so no explicit NULL branch is
--     needed and none is written.
--
-- Down (reverses to the 20261017000000 state):
--   alter table public.gdelt_event_cluster
--     drop constraint if exists gdelt_event_cluster_best_news_url_https;
--   alter table public.gdelt_event_cluster_outlet
--     drop constraint if exists gdelt_event_cluster_outlet_url_https;
--   alter table public.gdelt_event_cluster_outlet
--     add constraint gdelt_event_cluster_outlet_url_https check (
--       url like 'https://%'
--     );
--   alter table public.gdelt_event_cluster
--     drop constraint if exists gdelt_event_cluster_primary_url_https;
--   alter table public.gdelt_event_cluster
--     add constraint gdelt_event_cluster_primary_url_https check (
--       primary_url is null or primary_url like 'https://%'
--     );
--
-- Regex note: inside a Postgres ARE bracket expression, `\s` is the
-- shorthand for whitespace characters. With standard_conforming_strings
-- (on by default), the SQL literal `'^https://[^/\s]+'` passes the
-- bytes `^https://[^/\s]+` through to the regex engine, which then
-- interprets `\s` inside the character class. Verified empirically
-- against prod rows above — URLs starting with `s` (e.g. slate.com,
-- supremecourt.gov) are correctly accepted.

begin;

-- =========================================================================
-- 1. gdelt_event_cluster.primary_url — swap LIKE for host-required regex.
-- =========================================================================

alter table public.gdelt_event_cluster
  drop constraint if exists gdelt_event_cluster_primary_url_https;

alter table public.gdelt_event_cluster
  add constraint gdelt_event_cluster_primary_url_https check (
    primary_url is null or primary_url ~ '^https://[^/\s]+'
  );

comment on constraint gdelt_event_cluster_primary_url_https
  on public.gdelt_event_cluster is
  'Defense-in-depth: primary_url must be null, or https:// followed by at least one non-whitespace, non-slash character. PR #220 push-2 security-reviewer LOW 1.';

-- =========================================================================
-- 2. gdelt_event_cluster_outlet.url — swap LIKE for host-required regex.
-- =========================================================================

alter table public.gdelt_event_cluster_outlet
  drop constraint if exists gdelt_event_cluster_outlet_url_https;

alter table public.gdelt_event_cluster_outlet
  add constraint gdelt_event_cluster_outlet_url_https check (
    url ~ '^https://[^/\s]+'
  );

comment on constraint gdelt_event_cluster_outlet_url_https
  on public.gdelt_event_cluster_outlet is
  'Defense-in-depth: url must be https:// followed by at least one non-whitespace, non-slash character. PR #220 push-2 security-reviewer LOW 1.';

-- =========================================================================
-- 3. gdelt_event_cluster.best_news_url — new host-required https CHECK.
--    Postgres CHECK semantics skip NULL rows, so no explicit NULL
--    branch is written. The gdelt_event_cluster_best_news_coherent
--    constraint (20261016000000) already ensures (best_news_url is null
--    and best_news_host is null) OR (both are not null).
-- =========================================================================

alter table public.gdelt_event_cluster
  add constraint gdelt_event_cluster_best_news_url_https check (
    best_news_url ~ '^https://[^/\s]+'
  );

comment on constraint gdelt_event_cluster_best_news_url_https
  on public.gdelt_event_cluster is
  'Defense-in-depth: when best_news_url is present, it must be https:// followed by at least one non-whitespace, non-slash character. Null rows pass per standard Postgres CHECK semantics. PR #220 push-2 security-reviewer LOW 2.';

commit;
