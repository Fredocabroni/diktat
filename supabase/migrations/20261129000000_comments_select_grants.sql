-- Migration: comments_select_grants
--
-- Up:   grant SELECT on public.comments and public.comment_likes to
--       the `authenticated` role.
--
--       HOTFIX — prod is returning 500 on the comments panel. Error
--       logs show `comments.list_failed` with sqlstate `42501`
--       (insufficient privilege) and `comments.count_failed` HEAD
--       requests without a code (PostgREST swallows the sqlstate on
--       HEAD/count=exact). Root cause: 20261126000000_comments.sql
--       created the tables and installed RLS + SELECT policies
--       (`comments_select_authenticated`, `comment_likes_select_own`),
--       but did not grant the matching table SELECT privilege to
--       `authenticated`. This project tracks table-level privileges
--       explicitly (see 20260617160000_public_schema_grants_audit.sql);
--       the default PostgreSQL SELECT grant on `public` was revoked
--       by that audit migration, so an RLS policy alone is not enough
--       — the role also needs the SELECT privilege.
--
--       Writes stay RPC-only. `create_comment`, `delete_own_comment`,
--       and `toggle_comment_like` are SECURITY DEFINER functions with
--       their own `revoke all … from public` + `grant execute to
--       authenticated, service_role` (20261126000000:506-508). No
--       INSERT/UPDATE/DELETE grants on these tables — the RPCs are
--       the only writer by design.
--
--       Scope: only `comments` + `comment_likes`. Audited every other
--       table created since 2026-11-01:
--         * take5_sessions (20261105) — SELECT grant already present.
--         * drop_shadow_log (20261103) — service-role writes via RPC;
--           no authenticated read path by design.
--         * reports (20261112) — revoke all on authenticated;
--           submit_report RPC is the only path.
--         * age_block_tombstones + age_block_identity_tombstones
--           (20261115/20261120) — supabase_auth_admin SELECT only;
--           intentionally not authenticated-readable.
--         * geoip_country_blocks (20261123) — supabase_auth_admin
--           SELECT only; intentionally not authenticated-readable.
--       Only `comments` + `comment_likes` have user-facing SELECT
--       policies without the matching role grant, so only they need
--       the fix. Documented in CLAUDE.md § Data writes policy.
--
-- Down: revoke select on public.comments from authenticated;
--       revoke select on public.comment_likes from authenticated;
--       (Rolling back restores the prod 42501 — same-day-unblock only.)
--
-- Timestamp 20261129000000 — strictly greater than the current prod
-- max (20261128000000).

begin;

grant select on public.comments      to authenticated;
grant select on public.comment_likes to authenticated;

commit;
