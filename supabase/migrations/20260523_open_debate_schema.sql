-- Migration: open_debate_schema
-- Up:   battle_rounds.deadline_at nullable column (open_debate only -- trivia
--       ignores). New tables debate_arguments (per-seat blind submissions,
--       100-2000 chars, one per round per user) and debate_votes (one
--       community AP-weighted vote per non-participant per debate, decisive
--       per ADDICTION §6.3/§6.4). RLS on both new tables + one additive
--       policy on battle_rounds so authenticated observers can read
--       open_debate rounds.
-- Down: drop policy battle_rounds_select_open_debate_observers;
--       drop table public.debate_votes;
--       drop table public.debate_arguments;
--       alter table public.battle_rounds drop column deadline_at;
--
-- Design context (full scope in PR 4.5):
--   * Async turn-based tempo, 3 rounds (opening / rebuttal / closing). Within
--     a round both seats submit "blind" -- neither sees the other's until the
--     round reveals (both submitted OR deadline_at passed).
--   * ONE community vote at the END of the full debate (not per round).
--     ONE debate_score AI call on the complete exchange.
--   * Winner = community AP-weighted vote (decisive). AI score is advisory,
--     stored transparently. AI breaks the tie only when community AP is near
--     even. Both AI score AND community tally land in the round_no=3 verdict
--     row's payload so the UI (PR 4.6) can show them side-by-side -- vital
--     when they DISAGREE (§2 fairness flashpoint, addiction-auditor flag).
--   * The verdict "round" (round_no=3) is a synthetic battle_rounds row the
--     runner creates after round 2 reveals. Its deadline_at = the community
--     vote window close. Once that passes the runner scores + settles.

begin;

-- Nullable so existing trivia rounds (and future modes) ignore it.
alter table public.battle_rounds
  add column if not exists deadline_at timestamptz;

-- Runner query index: open-debate rounds awaiting transition.
create index if not exists battle_rounds_deadline_idx
  on public.battle_rounds (deadline_at)
  where deadline_at is not null and winner_user_id is null;

-- ---------------------------------------------------------------------------
-- debate_arguments: per-seat blind text submission per round.
-- ---------------------------------------------------------------------------
create table public.debate_arguments (
  id           uuid primary key default gen_random_uuid(),
  battle_id    uuid not null references public.battles(id)       on delete cascade,
  round_id     uuid not null references public.battle_rounds(id) on delete cascade,
  user_id      uuid not null references public.users(id)         on delete cascade,
  -- 100-2000 chars: enough rope for a real argument, short enough to discourage
  -- a wall of fluff. Tunable in a future polish pass.
  text         text not null check (char_length(text) between 100 and 2000),
  submitted_at timestamptz not null default now(),
  unique (round_id, user_id)
);

create index debate_arguments_battle_idx on public.debate_arguments (battle_id);
create index debate_arguments_round_idx  on public.debate_arguments (round_id);
create index debate_arguments_user_idx   on public.debate_arguments (user_id);

alter table public.debate_arguments enable row level security;

-- Author always sees their own argument (drafting + post-reveal).
create policy debate_args_select_own on public.debate_arguments for select to authenticated
  using (public.is_self(user_id));

-- Everyone authenticated (including the opponent + observers) reads the
-- argument only AFTER the round transitions to revealed/awaiting_final_vote/
-- scored -- this is the "blind submission" privacy guarantee, enforced at
-- the database layer rather than the API layer.
create policy debate_args_select_revealed on public.debate_arguments for select to authenticated
  using (
    exists (
      select 1 from public.battle_rounds r
      where r.id = debate_arguments.round_id
        and r.payload->>'state' in ('revealed', 'awaiting_final_vote', 'scored')
    )
  );

-- Only the author can submit; one row per (round, user) enforced by the
-- unique index. Participant-ness + deadline + round state are enforced by
-- the tRPC layer; RLS just locks down the row's identity.
create policy debate_args_insert_self on public.debate_arguments for insert to authenticated
  with check (public.is_self(user_id));

-- ---------------------------------------------------------------------------
-- debate_votes: one community AP-weighted vote per non-participant per
-- debate. The decisive verdict (§6.3 social proof + §6.4 authority).
-- ---------------------------------------------------------------------------
create table public.debate_votes (
  id               uuid primary key default gen_random_uuid(),
  battle_id        uuid not null references public.battles(id) on delete cascade,
  voter_user_id    uuid not null references public.users(id)   on delete cascade,
  vote_for_user_id uuid not null references public.users(id)   on delete cascade,
  -- Snapshot of the voter's AP at vote time. The tally weights by this --
  -- so a Vanguard+ voter counts more per Cialdini §6.4 authority.
  ap_at_vote_time  integer not null check (ap_at_vote_time >= 0),
  voted_at         timestamptz not null default now(),
  unique (battle_id, voter_user_id)
);

create index debate_votes_battle_idx   on public.debate_votes (battle_id);
create index debate_votes_voter_idx    on public.debate_votes (voter_user_id);
create index debate_votes_vote_for_idx on public.debate_votes (vote_for_user_id);

alter table public.debate_votes enable row level security;

-- Voter sees their own vote always.
create policy debate_votes_select_own on public.debate_votes for select to authenticated
  using (public.is_self(voter_user_id));

-- After settlement, all votes are public (social proof + auditability).
create policy debate_votes_select_settled on public.debate_votes for select to authenticated
  using (
    exists (
      select 1 from public.battles b
      where b.id = debate_votes.battle_id and b.status = 'settled'
    )
  );

-- Voter must be acting as themselves. Non-participant check + window check
-- live in the tRPC layer (RLS can't easily express "not a participant").
create policy debate_votes_insert_self on public.debate_votes for insert to authenticated
  with check (public.is_self(voter_user_id));

-- ---------------------------------------------------------------------------
-- battle_rounds: additive policy letting authenticated observers read open-
-- debate rounds. Trivia's existing participants-only policy is untouched.
-- This exposes round STATE/DEADLINE metadata (for live progress UI in 4.6);
-- the argument TEXT is gated by debate_arguments RLS, which keeps the blind
-- submission guarantee intact.
-- ---------------------------------------------------------------------------
create policy battle_rounds_select_open_debate_observers on public.battle_rounds for select to authenticated
  using (
    exists (
      select 1 from public.battles b
      where b.id = battle_rounds.battle_id
        and b.mode = 'open_debate'
        and b.status in ('live', 'settled')
    )
  );

commit;
