-- Migration: #220 security-reviewer LOWs 1 and 2 — strengthen the
-- https-URL CHECK on gdelt_event_cluster.primary_url and
-- gdelt_event_cluster_outlet.url from `LIKE 'https://%'` to a fully-
-- anchored regex that rejects (a) a bare scheme or whitespace-after-
-- scheme, (b) credential-injection via `user@host`, and (c) any URL
-- that is not entirely composed of non-whitespace characters. Extend
-- the same CHECK to gdelt_event_cluster.best_news_url (deliberately
-- excluded in 20261017000000, flagged as LOW 2 for column symmetry).
--
-- Operator decision 2026-10-15 (PR #221 push-2 security-reviewer
-- BLOCK on MEDIUM: `https://attacker.com@internal.svc/` passed the
-- initial `^https://[^/\s]+` pattern because `@` was in the host
-- character class). The replacement pattern is:
--
--   ^https://[^/?#@\s]+([/?#][^\s]*)?$
--
-- Parts:
--   ^https://           — scheme prefix anchored at start.
--   [^/?#@\s]+          — one or more host[:port] characters that are
--                         NOT slash, query mark, hash, at-sign, or
--                         any whitespace. Rejecting `@` closes the
--                         `user@host` credential-injection bypass
--                         (URL parsers treat the pre-`@` segment as
--                         credentials and route the request to the
--                         post-`@` host, past any name-based filter
--                         that looked at the raw prefix). Rejecting
--                         `/`, `?`, `#` keeps the host segment from
--                         consuming path/query/fragment delimiters.
--   ([/?#][^\s]*)?      — optional path, query, or fragment: must
--                         start with `/`, `?`, or `#`, then any
--                         non-whitespace characters (allows ports
--                         inside the authority — `:` is already in
--                         the host class — plus `/@user` in paths
--                         like `https://medium.com/@user`).
--   $                   — anchored at end-of-string. Required: `~`
--                         is substring-matching by default, so an
--                         unanchored pattern would match the clean
--                         prefix of `https://good.com whatever` and
--                         still return TRUE. The end anchor is what
--                         makes the whitespace / `\r` / `@` rejects
--                         actually bind.
--
-- Why `\s` matters: Postgres ARE interprets `\s` inside a bracket
-- expression as the whitespace shorthand. With standard_conforming_
-- strings on (default), the SQL literal passes the bytes through
-- verbatim and the regex engine does the interpretation. Verified
-- empirically against prod — URLs starting with `s` (slate.com,
-- supremecourt.gov) and legitimate `/@user` paths (medium.com) are
-- correctly accepted.
--
-- The only writer today is the SECURITY DEFINER RPC
-- upsert_gdelt_event_mention, whose callers already pass
-- requireHttpsUrl() + classifyUrl() — so this is a storage-layer
-- defense-in-depth tightening, not an active bypass fix. IP-literal
-- rejection and application-layer URL-credentials rejection are
-- intentionally NOT part of this migration (recorded in #215 as
-- app-layer follow-ups).
--
-- Prod violation count (read-only pre-apply SELECT 2026-10-15 against
-- prod project ref immzaaysjlftyijwdsrm, re-run with the new pattern):
--   gdelt_event_cluster.primary_url:     0 non-matching / 0 non-null / 546 rows
--   gdelt_event_cluster.best_news_url:   0 non-matching / 32 non-null / 546 rows
--   gdelt_event_cluster_outlet.url:      0 non-matching / 553 non-null / 553 rows
-- Zero violations across all three columns → each regex CHECK
-- validates immediately (no NOT VALID + VALIDATE split needed).
--
-- Up:
--   drop constraint gdelt_event_cluster_primary_url_https on
--     public.gdelt_event_cluster;
--   add constraint gdelt_event_cluster_primary_url_https on
--     public.gdelt_event_cluster: primary_url IS NULL OR
--     primary_url ~ '^https://[^/?#@\s]+([/?#][^\s]*)?$'. The NULL
--     branch is preserved — primary_url is nullable until the first
--     primary/direct mention lands.
--   drop constraint gdelt_event_cluster_outlet_url_https on
--     public.gdelt_event_cluster_outlet;
--   add constraint gdelt_event_cluster_outlet_url_https on
--     public.gdelt_event_cluster_outlet: url ~
--     '^https://[^/?#@\s]+([/?#][^\s]*)?$'. url is NOT NULL, no null
--     branch.
--   add constraint gdelt_event_cluster_best_news_url_https on
--     public.gdelt_event_cluster: best_news_url ~
--     '^https://[^/?#@\s]+([/?#][^\s]*)?$'. best_news_url is
--     nullable; Postgres CHECK semantics skip NULL rows per the SQL
--     standard, so no explicit NULL branch is written.
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

begin;

-- =========================================================================
-- 1. gdelt_event_cluster.primary_url — swap LIKE for host-required,
--    end-anchored regex that also rejects user@host credential-injection.
-- =========================================================================

alter table public.gdelt_event_cluster
  drop constraint if exists gdelt_event_cluster_primary_url_https;

alter table public.gdelt_event_cluster
  add constraint gdelt_event_cluster_primary_url_https check (
    primary_url is null
    or primary_url ~ '^https://[^/?#@\s]+([/?#][^\s]*)?$'
  );

comment on constraint gdelt_event_cluster_primary_url_https
  on public.gdelt_event_cluster is
  'Defense-in-depth: primary_url must be null, or a fully-anchored https URL whose host contains no slash, query mark, hash, at-sign, or whitespace, optionally followed by a path/query/fragment. Rejects `https://user@host` credential-injection. End anchor is required because `~` is substring-matching. PR #221 push-2 security-reviewer MEDIUM fix (#220 LOW 1 origin).';

-- =========================================================================
-- 2. gdelt_event_cluster_outlet.url — same shape, NOT NULL, no null branch.
-- =========================================================================

alter table public.gdelt_event_cluster_outlet
  drop constraint if exists gdelt_event_cluster_outlet_url_https;

alter table public.gdelt_event_cluster_outlet
  add constraint gdelt_event_cluster_outlet_url_https check (
    url ~ '^https://[^/?#@\s]+([/?#][^\s]*)?$'
  );

comment on constraint gdelt_event_cluster_outlet_url_https
  on public.gdelt_event_cluster_outlet is
  'Defense-in-depth: url must be a fully-anchored https URL whose host contains no slash, query mark, hash, at-sign, or whitespace, optionally followed by a path/query/fragment. Rejects `https://user@host` credential-injection. End anchor is required because `~` is substring-matching. PR #221 push-2 security-reviewer MEDIUM fix (#220 LOW 1 origin).';

-- =========================================================================
-- 3. gdelt_event_cluster.best_news_url — new regex CHECK. No NULL branch:
--    Postgres CHECK semantics skip NULL rows, and the pre-existing
--    gdelt_event_cluster_best_news_coherent constraint from migration
--    20261016000000 already ensures (best_news_url is null and
--    best_news_host is null) OR (both are not null).
-- =========================================================================

alter table public.gdelt_event_cluster
  add constraint gdelt_event_cluster_best_news_url_https check (
    best_news_url ~ '^https://[^/?#@\s]+([/?#][^\s]*)?$'
  );

comment on constraint gdelt_event_cluster_best_news_url_https
  on public.gdelt_event_cluster is
  'Defense-in-depth: when best_news_url is present, it must be a fully-anchored https URL whose host contains no slash, query mark, hash, at-sign, or whitespace, optionally followed by a path/query/fragment. Null rows pass per standard Postgres CHECK semantics. PR #221 push-2 security-reviewer MEDIUM fix (#220 LOW 2 origin).';

commit;
