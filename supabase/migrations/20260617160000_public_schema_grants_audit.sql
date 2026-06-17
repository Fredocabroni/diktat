-- Migration: public_schema_grants_audit
-- Up:   Grant table-level SELECT (and where appropriate INSERT/UPDATE/DELETE)
--       to anon + authenticated on every public table that has a policy
--       authorising those operations. Replace one PERMISSIVE policy
--       (news_topics_select_all) with the tightened
--       news_topics_select_released. Replace the read-all policy on
--       tribe_memberships with self-only. Apply column-level SELECT to
--       fact_check_claims so created_by stays service-role-only. Do NOT
--       set ALTER DEFAULT PRIVILEGES for anon/authenticated — the
--       Postgres default (no automatic privileges on new tables) is
--       what we want; every future migration must grant explicitly.
-- Down: Run the rollback script below. It (a) revokes every grant
--       this migration issues, (b) drops the two replacement policies,
--       (c) restores the original `news_topics_select_all` and
--       `tribe_memberships_select_all` read-all policies verbatim,
--       returning the schema to its exact pre-migration state.
--
-- ---------------------------------------------------------------------------
-- ROLLBACK SCRIPT (run as postgres / supabase-admin)
-- ---------------------------------------------------------------------------
-- begin;
--
-- -- Revoke A-class grants.
-- revoke select on public.ap_transactions from authenticated;
-- revoke select, insert on public.battle_participants from authenticated;
-- revoke select on public.battle_rounds from authenticated;
-- revoke select on public.battles from authenticated;
-- revoke select on public.clips from anon, authenticated;
-- revoke select, insert on public.debate_arguments from authenticated;
-- revoke select, insert on public.debate_votes from authenticated;
-- revoke select, insert on public.opinion_shifts from authenticated;
-- revoke select, insert on public.predictions from authenticated;
-- revoke select, insert, update on public.sessions from authenticated;
-- revoke select on public.streaks from authenticated;
-- revoke select on public.trivia_answers from authenticated;
-- revoke select on public.trivia_questions from authenticated;
-- revoke select, insert, delete on public.user_push_subscriptions from authenticated;
-- revoke select on public.wallets from authenticated;
--
-- -- Revoke D-class grants.
-- revoke select on public.fact_check_verdicts from authenticated;
-- revoke select on public.fact_check_sources from authenticated;
-- revoke select on public.tiers from anon, authenticated;
-- revoke select on public.tribes from anon, authenticated;
--
-- -- B-class: news_topics — drop the released-only policy + grant,
-- -- restore the original read-all policy verbatim.
-- revoke select on public.news_topics from anon, authenticated;
-- drop policy if exists news_topics_select_released on public.news_topics;
-- create policy news_topics_select_all on public.news_topics
--   for select to anon, authenticated using (true);
--
-- -- B-class: fact_check_claims — revoke the column-level grant.
-- revoke select (id, claim_text, claim_context, dedup_hash, ref_type, ref_id, created_at)
--   on public.fact_check_claims from authenticated;
--
-- -- B-class: tribe_memberships — drop the self-only policy + grant,
-- -- restore the original read-all policy verbatim.
-- revoke select, insert, delete on public.tribe_memberships from authenticated;
-- drop policy if exists tribe_memberships_select_self on public.tribe_memberships;
-- create policy tribe_memberships_select_all on public.tribe_memberships
--   for select to anon, authenticated using (true);
--
-- commit;
-- ---------------------------------------------------------------------------
--
-- Why this exists
-- ---------------
-- The dev DB has had zero SELECT (or other) grants to anon/authenticated
-- on any table in `public` since the first migrations landed. Only
-- `service_role` carries grants (via 20260427_grant_service_role_public.sql).
-- Every RLS policy of the shape `to anon, authenticated ... using ...`
-- across our migrations is therefore dead-letter: the GRANT layer denies
-- the call with 42501 before RLS is consulted.
--
-- The impact was empirically proven by `apps/api/scripts/probe-feed-list-runtime.ts`
-- (PR #40 round-4 commit 0895372): every tRPC reader endpoint built on
-- `userScopedClient` (anon-key + user bearer → `authenticated` role)
-- returns 42501 against real PostgREST in the dev DB. wallet.balance,
-- user.me, debates.getBattle, feed.list, feed.recordShift, tribes.list,
-- factCheck.getVerdict, every other reader. The runtime path is broken
-- everywhere; unit tests pass on fakeDb (mock).
--
-- This migration is the audit-then-grant fix. Each grant in this file
-- matches an existing policy on the same table; the policy stays as the
-- row-level filter, the grant lets PostgREST evaluate it. Operations
-- (SELECT/INSERT/UPDATE/DELETE) are granted only where a policy permits
-- them; we do not grant excess privileges as belt-and-suspenders against
-- a future policy regression.
--
-- LOCKED scope (per PR review on the audit table)
-- -----------------------------------------------
-- A-class — 15 tables with correctly-scoped policies, grant matching ops:
--   ap_transactions (SELECT)
--   battle_participants (SELECT, INSERT)
--   battle_rounds (SELECT)
--   battles (SELECT)
--   clips (SELECT — published=true is self-documenting; no read-all comment)
--   debate_arguments (SELECT, INSERT)
--   debate_votes (SELECT, INSERT)
--   opinion_shifts (SELECT, INSERT)
--   predictions (SELECT, INSERT)
--   sessions (SELECT, INSERT, UPDATE)
--   streaks (SELECT)
--   trivia_answers (SELECT)
--   trivia_questions (SELECT)
--   user_push_subscriptions (SELECT, INSERT, DELETE)
--   wallets (SELECT)
--
-- D-class — 4 tables with INTENTIONAL read-all policies, grant SELECT
-- with an explicit header comment so the next auditor sees the
-- intent, not the wording:
--   fact_check_verdicts, fact_check_sources, tiers, tribes
--
-- B-class — 3 tables that need tightening before grant:
--   news_topics            → drop read-all, create released-only policy
--   fact_check_claims      → column-level grant only (omit created_by)
--   tribe_memberships      → drop read-all, create self-only policy;
--                            grant SELECT/INSERT/DELETE
--
-- C-class — 3 tables stay service-role only by design:
--   news_topics_candidates, scheduled_jobs, x_posts (no grant — already
--   covered by service_role grants via 20260427)
--
-- E (orphan) — fact_checks: untouched here; separate cleanup migration
-- queued for the DROP after a verified codebase grep showed zero source
-- references (only generated types reference it).
--
-- EXCLUDED — users: column-level grants + self-read path are a separate
-- PR. Reads of users today via ctx.db will still 42501 after this
-- migration lands; that surface needs its own scoping decision (which
-- columns are public, where self-only reads route through a SECURITY
-- DEFINER RPC or a service-role-scoped router) before it gets grants.
-- Track in TYRION_BUILD_QUEUE under "users access PR".
--
-- DEFERRED — public-with-opt-out tribe visibility: tribe_memberships
-- ships self-only in this migration. The "show my tribe to others"
-- product feature (visibility preference on users + relaxed policy +
-- settings toggle + UI plumbing) is logged as its own feature PR in
-- TYRION_BUILD_QUEUE. Sequencing is intentional: start self-only and
-- relax to public-unless-opted-out once the opt-out control exists.

begin;

-- ---------------------------------------------------------------------------
-- A-class: matching grants for correctly-scoped policies
-- ---------------------------------------------------------------------------

grant select on public.ap_transactions to authenticated;

grant select, insert on public.battle_participants to authenticated;

grant select on public.battle_rounds to authenticated;

grant select on public.battles to authenticated;

-- clips: policy is `clips_select_published using (published = true)` to
-- {anon, authenticated}. Only published clips leak; the predicate is
-- self-documenting.
grant select on public.clips to anon, authenticated;

grant select, insert on public.debate_arguments to authenticated;

grant select, insert on public.debate_votes to authenticated;

grant select, insert on public.opinion_shifts to authenticated;

grant select, insert on public.predictions to authenticated;

grant select, insert, update on public.sessions to authenticated;

grant select on public.streaks to authenticated;

grant select on public.trivia_answers to authenticated;

grant select on public.trivia_questions to authenticated;

grant select, insert, delete on public.user_push_subscriptions to authenticated;

grant select on public.wallets to authenticated;

-- ---------------------------------------------------------------------------
-- D-class: INTENTIONAL read-all by product contract
-- ---------------------------------------------------------------------------

-- fact_check_verdicts: verdict content + provenance auditable by every
-- user per the PR 4.7 §2 contract. The row carries no user-attribution
-- (only claim_id → fact_check_claims). Read-all is the intended posture,
-- not a miss.
grant select on public.fact_check_verdicts to authenticated;

-- fact_check_sources: per-verdict source URL list with fetch_status.
-- Auditability of the URLs the verdict cites. The row carries no user
-- reference (only verdict_id → fact_check_verdicts). Read-all is the
-- intended posture.
grant select on public.fact_check_sources to authenticated;

-- tiers: the 12-tier reference catalog (ap_min/ap_max/payout_eligible/
-- cosmetics). Public by §1 product spec. Read-all is the intended posture.
grant select on public.tiers to anon, authenticated;

-- tribes: the 5 starter tribes (slug, name, description, manifesto).
-- Public catalog, loaded during onboarding before any auth. Read-all is
-- the intended posture.
grant select on public.tribes to anon, authenticated;

-- ---------------------------------------------------------------------------
-- B-class: tighten then grant
-- ---------------------------------------------------------------------------

-- news_topics: replace the dead-letter read-all policy with one that
-- enforces the same contract feed.list already filters on
-- (is_drop = true AND drop_at <= now()). Defense in depth alongside the
-- API's input-schema refine + Math.min server-side clamp on the cursor.
-- Closes the round-2 security-reviewer MEDIUM #2 on PR #40 at the DB
-- layer.
drop policy if exists news_topics_select_all on public.news_topics;

create policy news_topics_select_released on public.news_topics
  for select to anon, authenticated
  using (is_drop = true and drop_at <= now());

grant select on public.news_topics to anon, authenticated;

-- fact_check_claims: column-level SELECT. `created_by` is per-user
-- attribution metadata (who enqueued the claim) and stays ungranted —
-- service-role only. The policy `fact_check_claims_select_all` is kept
-- in place so the granted columns are reachable; the unmissable
-- `created_by` column simply isn't selectable by anon/authenticated.
grant select (id, claim_text, claim_context, dedup_hash, ref_type, ref_id, created_at)
  on public.fact_check_claims to authenticated;

-- tribe_memberships: replace the default-permissive read-all policy
-- with self-only. This is a CONSCIOUS scoping call — tribe membership
-- is faction-affiliation data and no §1 line designates rosters as
-- public-by-default. The grant matches the existing
-- insert/delete-self policies. Cross-user reads are deferred to the
-- "public-with-opt-out tribe visibility" feature PR (queued).
drop policy if exists tribe_memberships_select_all on public.tribe_memberships;

create policy tribe_memberships_select_self on public.tribe_memberships
  for select to authenticated
  using (is_self(user_id));

grant select, insert, delete on public.tribe_memberships to authenticated;

-- ---------------------------------------------------------------------------
-- C-class: no grant to anon/authenticated by design
-- ---------------------------------------------------------------------------
--
-- The following three tables stay service-role only — no client-facing
-- read path exists by design. service_role grants are in place via
-- 20260427_grant_service_role_public.sql. Listed here so the next
-- auditor sees the absence is deliberate, not a miss:
--
--   public.news_topics_candidates  -- staging table, internal pipeline.
--                                     `20260616120000:156` already does
--                                     `revoke all from anon, authenticated`;
--                                     belt-and-suspenders to the omission.
--   public.scheduled_jobs          -- internal job queue.
--   public.x_posts                 -- bot xpost ledger; internal.

-- ---------------------------------------------------------------------------
-- Default privileges for future tables — DELIBERATELY UNCHANGED
-- ---------------------------------------------------------------------------
--
-- This migration issues NO `alter default privileges` statements for
-- anon or authenticated. That is intentional. The Postgres default for
-- new tables — no automatic privileges to either role — is exactly the
-- posture we want. Issuing a blanket `alter default privileges ... grant
-- select ... to authenticated` here would over-grant every future C-class
-- table (internal queues, logs, staging tables) without an audit-visible
-- decision in the migration that creates them.
--
-- The contract this migration establishes for the next person writing a
-- public-schema migration:
--   - service_role: full read/write on every new table (already in place
--     via `20260427_grant_service_role_public.sql`'s default privileges).
--   - anon, authenticated: NO automatic grant. Every new table that
--     intends a client read/write path must include a `grant ... to
--     anon/authenticated` line in the same migration that creates it,
--     matching the operations its RLS policy authorises.
--
-- A missing grant is therefore a deliberate "service-role only" decision
-- visible in the migration history — not the silent omission that caused
-- the systemic gap this audit fixes.

commit;
