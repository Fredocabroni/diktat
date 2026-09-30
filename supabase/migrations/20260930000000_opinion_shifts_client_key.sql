-- Migration: opinion_shifts idempotency support (Issue #127 H11 PR B1).
--
-- Part 1 of a two-PR series:
--   B1 (this migration): dedupe two known-bad prod rows, add nullable
--                        client_key column, add partial unique index on
--                        (user_id, client_key). NO server or client code
--                        changes. The column stays nullable so today's
--                        writes (which have no key) continue to succeed.
--   B2 (follow-up):      server accepts a per-tap client_key from the
--                        client, populates the column, and on a 23505
--                        conflict looks up the existing row (self-scoped)
--                        and returns it. Client generates a fresh UUID
--                        per tap, retries reuse the same key, success
--                        clears the key so the next tap gets a new one.
--
-- Ordering rule: B2 code MUST NOT deploy before this migration is applied
-- in prod. If it did, api writes to a nonexistent column and every
-- recordShift call fails. This migration is safe to deploy first because
-- the column is nullable — today's null-writing api path is unaffected.
--
-- Semantic contract for opinion_shifts: multiple rows per (user_id,
-- topic_id) are intentional and load-bearing. Evidence:
--   docs/MASTER_PLAN.md:179       — "Changed My Mind" badges for flipping positions.
--   supabase/migrations/20260420090005_news_predictions_factchecks_clips.sql:44-49
--                                 — "Append-only: users can record and read their own
--                                    shifts but never edit or delete prior records
--                                    (history integrity for tribe leaderboards +
--                                    opinion-change analytics)."
--   supabase/migrations/20260420090011_opinion_shifts_composite_index.sql:2-5
--                                 — composite index (user_id, topic_id, created_at desc)
--                                    exists specifically for change-of-mind detection.
--
-- So a unique on (user_id, topic_id) would kill Changed-My-Mind. The
-- right shape is per-submit idempotency: unique on (user_id, client_key)
-- WHERE client_key is not null.
--
-- Down (reference, not auto-run):
--   drop index if exists public.opinion_shifts_user_client_key_uniq;
--   alter table public.opinion_shifts drop column if exists client_key;

begin;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Dedupe two known-bad prod rows by exact id.
--
-- Recon summary (Issue #127 H11 recon on 2026-09-30):
-- Prod holds 5 rows for one (user, topic) pair created within ~104 seconds
-- on 2026-09-08. Time-gap analysis shows two of them are retry-storm
-- artifacts (same after_position within 30 seconds of the first row),
-- and three are legitimate history (initial vote + two mind-changes).
-- The two retry duplicates:
--   51d02b85-9edc-4199-be7c-dc159e133691  (2026-09-08 17:19:38 UTC, 0→1)
--   57ee4f86-7222-42e9-83c0-1f432d0b4502  (2026-09-08 17:19:57 UTC, 0→1)
--
-- Both fired the opinion_shifts_take5_after_insert trigger, over-crediting
-- take5_progress by +2 for user 730971d4-… (handle citizen_730971d4e7,
-- not a bot) on 2026-09-08. The advancement it caused has already been
-- broken by 3 weeks of inactivity — current_length is 0 today — so no
-- balance/streak unwind is needed. Removing the rows brings the ledger
-- into line with the honest history (rows 1, 4, 5 preserved).
--
-- Delete-by-exact-id, not a window rule: the window rule could match
-- future legitimate rapid-fire mind changes. Exact-id is surgical and
-- reproducible.
--
-- opinion_shifts has NO inbound foreign keys (verified via
-- information_schema.table_constraints against
-- ccu.table_name='opinion_shifts' — zero rows). Deleting these ids
-- cannot cascade into other tables.
--
-- On a fresh CI DB the two ids do not exist; the DELETE succeeds with
-- ZERO rows removed. The DO block still runs cleanly. This is
-- migrations-fresh-apply-safe by construction — no `raise exception`
-- on empty match.
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  v_row record;
  v_deleted int := 0;
begin
  for v_row in
    delete from public.opinion_shifts
    where id in (
      '51d02b85-9edc-4199-be7c-dc159e133691'::uuid,
      '57ee4f86-7222-42e9-83c0-1f432d0b4502'::uuid
    )
    returning id, user_id, topic_id, before_position, after_position, created_at
  loop
    v_deleted := v_deleted + 1;
    raise notice
      'opinion_shifts H11 dedupe: deleted id=% user_id=% topic_id=% before=% after=% created_at=%',
      v_row.id, v_row.user_id, v_row.topic_id,
      v_row.before_position, v_row.after_position, v_row.created_at;
  end loop;
  raise notice 'opinion_shifts H11 dedupe: total rows deleted = %', v_deleted;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Add client_key column (nullable).
--
-- Nullable is required because existing rows have no key. B2's server
-- change will make new writes send a uuid; older rows keep null.
-- ───────────────────────────────────────────────────────────────────────────

alter table public.opinion_shifts
  add column if not exists client_key uuid;

comment on column public.opinion_shifts.client_key is
  'Per-tap idempotency key generated by the client. Populated by B2 server
   change; null on rows written before that landed. Unique per user via
   the partial index below — enforces retry safety without breaking the
   append-only change-of-mind semantics on (user_id, topic_id).';

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Partial unique index on (user_id, client_key).
--
-- Composite with user_id (not client_key alone) so a hypothetical
-- collision on client-generated uuids across users doesn't cause a
-- cross-user 23505 (which would be a data-leak vector: the follow-up
-- server code SELECTs the conflicting row and returns it self-scoped —
-- the composite guarantees a colliding row is always same-user).
--
-- `where client_key is not null` so the many pre-B2 rows with null
-- client_key are exempt. Two null values compare not-equal in Postgres
-- so an implicit-null index would allow duplicate nulls anyway, but
-- the partial predicate is explicit contract.
-- ───────────────────────────────────────────────────────────────────────────

create unique index if not exists opinion_shifts_user_client_key_uniq
  on public.opinion_shifts (user_id, client_key)
  where client_key is not null;

commit;
