# Insert-policy sweep — 2026-11-10

Repeatable sweep of every live client-facing `for insert` RLS policy on
`main`, classified against the H3 shape (coupled-invariant writes that
RLS `with check` cannot express — see `CLAUDE.md` § **Data writes: RLS
vs SECURITY DEFINER RPC**).

**Scope.** Everything on `main` as of 2026-11-10. PR #311 (comments) is
pre-merge; its migration adds no client INSERT policy (writes go through
`create_comment` RPC) so it is already compliant and not re-listed here.

**Method.**

1. `grep -rniE "create policy .* for insert to (authenticated|anon)" supabase/migrations/*.sql`.
2. For each live policy (minus those explicitly dropped in a later
   migration), read the `with check`, the code callers, and any
   triggers that fire on insert.
3. Classify:
   - **INERT** — row's validity is fully expressible in `with check`; no
     coupled AP debit / server-authoritative value / eligibility gate /
     trigger-driven economy effect. Policy is correctly scoped.
   - **H3-SHAPED** — an accepted row drives at least one state change
     the `with check` cannot validate. The `*_insert_self` policy is
     bypassable (POST directly to PostgREST, skip the tRPC guards).
     Fix = SECURITY DEFINER RPC + drop the policy.
4. Doc-only: this is a report, not a fix. Each H3-SHAPED row is a
   follow-up ticket.

## Live policies on `main`

| #   | Table                            | Policy                                | `with check`                                                                             | Verdict                                              |
| --- | -------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 1   | `public.sessions`                | `sessions_insert_self`                | `is_self(user_id) and started_at <= now() and started_at >= now() - interval '1 minute'` | **INERT**                                            |
| 2   | `public.battle_participants`     | `bp_insert_self`                      | `is_self(user_id)`                                                                       | **FIXED** — dropped `20261127000000` (this PR)       |
| 3   | `public.tribe_memberships`       | `tribe_memberships_insert_self`       | `is_self(user_id) and weekly_ap = 0 and is_primary = false`                              | **INERT**                                            |
| 4   | `public.debate_arguments`        | `debate_args_insert_self`             | `is_self(user_id)`                                                                       | **FIXED** — RPC + dropped `20261128000000` (this PR) |
| 5   | `public.user_push_subscriptions` | `user_push_subscriptions_insert_self` | `is_self(user_id)`                                                                       | **INERT**                                            |
| 6   | `public.trivia_answers`          | `trivia_a_no_direct_insert`           | `false`                                                                                  | **DENY — by design**                                 |

Policies dropped in a later migration (recorded for the sweep's audit
trail; no longer a live surface):

- `predictions_insert_self` → dropped `20260729120000` (PR #107, the H3 reference).
- `debate_votes_insert_self` → dropped `20260730120000` (PR #114).
- `opinion_shifts_insert_self` → dropped `20261010100000`.
- `bp_insert_self` → dropped `20261127000000` (F1 of this sweep).
- `debate_args_insert_self` → dropped `20261128000000` (F2 of this sweep).

## Findings

### F1 — `bp_insert_self` is H3-shaped today (not just the-day-entry_ap-becomes-a-stake) — **FIXED**

Dropped in migration `supabase/migrations/20261127000000_drop_bp_insert_self.sql`.
Pre-fix grep confirmed no user-scoped Supabase client inserts into
`battle_participants` — the three in-tree writers (the matchmaker at
`apps/workers/src/jobs/matchmake.ts:391`, the probe script at
`apps/api/scripts/probe-trivia-correct-index-runtime.ts:123`, and the
open-debate resume validator at
`apps/workers/scripts/validate-open-debate-resume.ts:168`) all use the
service-role client and bypass RLS, so dropping the client INSERT
policy is pure attack-surface removal. SELECT policies
(`bp_select_self`, `battle_participants_select_open_debate_observers`)
unchanged.

**Table.** `public.battle_participants`.
**Migration.** `supabase/migrations/20260420090004_battles_and_trivia.sql:43`.
**`with check`.** `public.is_self(user_id)` — bare ownership, no other predicate.

**Why H3.** The only intended writer is the matchmaker worker
(`apps/workers/src/jobs/matchmake.ts:391`, running as service-role).
The service-role write snapshots server-authoritative state before
inserting both participant rows: both seats' AP band (±200 queue window),
a server-generated `battle_id` whose `status` must be `queued` /
`live`, seat ordering (`seat: 0 | 1`), and `entry_ap: 0` as a reserved
field that will become a stake. **None of that is in the RLS**: a
normal authenticated user can `POST /rest/v1/battle_participants` with
any `battle_id` + `seat` + `entry_ap` and the row is accepted.

What a hostile client can do today, with the policy as-is:

- Join a `settled` or `live` battle they were never matched into (bypasses
  matchmaking fairness, inserts themselves as a late participant that
  the open-debate / trivia tick loops will try to score).
- Join their own battle twice as two different seats.
- Pre-stamp `entry_ap > 0` without the corresponding AP debit — the
  rpc-less path never visits `apply_ap_drafts` / a ledger, so the AP
  "stake" is free.

#115 already flagged this as "H3-shaped the day `entry_ap` becomes a
real stake." The sweep upgrades the severity: the state-gate bypass is
live today, before `entry_ap` becomes load-bearing. `bp_insert_self` is
also effectively dead code (no client-side caller) — the follow-up is
simply to drop the policy, since the service-role matchmaker already
has `grant insert` and does not need it.

**Follow-up.** One-file migration that `drop policy if exists
bp_insert_self on public.battle_participants;`. Keep the service-role
grant. Keep `bp_select_self`. Re-run the fresh-apply gate; no
code changes.

### F2 — `debate_args_insert_self` was H3-shaped — **FIXED**

Routed through the SECURITY DEFINER RPC `public.submit_debate_argument`
in migration `supabase/migrations/20261128000000_debate_args_submit_rpc.sql`.
The dropped `debate_args_insert_self` policy's `with check` was
`is_self(user_id)` only — bare ownership — while the tRPC resolver
`debates.submitArgument` enforced four coupled invariants RLS cannot
express: round exists and is in `awaiting_arguments`, not past
`deadline_at`, not the verdict round, caller is a battle participant.
A hostile client that skipped tRPC could insert arguments past the
deadline (snipe the opponent's reveal), on a `settled` round, or
without being a participant at all. The unique `(round_id, user_id)`
index only blocked a same-seat second submission.

Pattern repeat of PR #114 (`cast_debate_vote`): the RPC derives the
submitter from `auth.uid()`, reads the round and participation
server-side, and enforces the four gates in one transaction. `set
search_path = ''`, EXECUTE revoked from `public` and granted to
`authenticated` + `service_role`. The INSERT grant on
`public.debate_arguments` is revoked so even an accidental future
policy recreation stays unreachable.

The same migration also revokes the now-unreachable INSERT grant on
`public.battle_participants` (follow-on from F1 / security-reviewer
note on PR #322 — one-liner).

Behavioral test: `supabase/tests/sql/submit_debate_argument.test.sql`
(non-participant → DA004; past-deadline → DA003; participant before
deadline → accepted with server-derived `user_id`; direct
authenticated INSERT → 42501; catalog check: no authenticated/anon
INSERT policy remains).

## Inert policies (no action)

### `sessions_insert_self`

The 1-minute `started_at` window prevents backfill, `is_self(user_id)`
scopes ownership, and the row is purely a session-activity record with
no AP effect, no AFTER INSERT trigger, and no coupled state. Fine
as-is.

### `tribe_memberships_insert_self`

The `weekly_ap = 0 and is_primary = false` clauses lock the two
client-forgeable fields. The composite PK `(user_id, tribe_id)`
prevents double-join (`tribes.join` treats 23505 as idempotent). No
AFTER INSERT trigger, no AP debit, no cooldown or max-tribes gate.
`tribes.join` (`apps/api/src/routers/tribes.ts:34`) delegates to RLS
by design. Fine as-is.

### `user_push_subscriptions_insert_self`

The row stores a Web Push endpoint for the user. No AP effect, no
server-authoritative snapshotting, no trigger beyond
`set_updated_at`. #115 classified as inert. Confirmed. Fine as-is.

### `trivia_a_no_direct_insert`

`with check (false)` — a _deny_ policy that blocks every client INSERT
on `trivia_answers`. All writes are forced through the `submit_trivia_answer`
RPC. Correctly scoped by design; not an H3 candidate.

## Next sweep

Re-run this sweep after any migration that lands a new `for insert to
authenticated` policy. The one-command check is the top of **Method**.
Also re-run when a currently-inert policy's row shape grows a coupled
effect (e.g. tribe_memberships picks up a cooldown column, or sessions
gains an AFTER INSERT trigger with economy side-effects).
