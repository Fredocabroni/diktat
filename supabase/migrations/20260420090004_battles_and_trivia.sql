-- Migration: battles + trivia tables
-- Up:   battles, battle_participants, battle_rounds, trivia_questions, trivia_answers.
--       battles.topic_id is forward-declared; FK to news_topics is added in the next migration.
-- Down: drop in reverse FK order.

begin;

create table public.battles (
  id              uuid primary key default gen_random_uuid(),
  mode            text not null check (mode in ('trivia','open_debate','voice_debate')),
  status          text not null default 'queued' check (status in ('queued','live','settled','cancelled')),
  topic_id        uuid,
  winner_user_id  uuid references public.users(id) on delete set null,
  ap_pot          integer not null default 0 check (ap_pot >= 0),
  started_at      timestamptz,
  ended_at        timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index battles_status_idx       on public.battles (status);
create index battles_mode_started_idx on public.battles (mode, started_at desc);
create index battles_winner_idx       on public.battles (winner_user_id);
create trigger battles_set_updated_at before update on public.battles
  for each row execute function public.set_updated_at();
alter table public.battles enable row level security;

create table public.battle_participants (
  battle_id  uuid not null references public.battles(id) on delete cascade,
  user_id    uuid not null references public.users(id)   on delete cascade,
  seat       smallint not null check (seat >= 0),
  entry_ap   integer not null check (entry_ap >= 0),
  result     text check (result in ('win','loss','draw','void')),
  joined_at  timestamptz not null default now(),
  primary key (battle_id, user_id)
);
create index battle_participants_user_idx on public.battle_participants (user_id);
alter table public.battle_participants enable row level security;
create policy bp_select_self on public.battle_participants for select to authenticated
  using (public.is_self(user_id));
-- Allow self-join: authenticated users can claim a seat as themselves only.
-- Server-side workers (service-role) bypass RLS and handle entry_ap deduction + seat assignment;
-- this policy is the user-initiated join path.
create policy bp_insert_self on public.battle_participants for insert to authenticated
  with check (public.is_self(user_id));

create policy battles_select_participants on public.battles for select to authenticated
  using (exists (
    select 1 from public.battle_participants p
    where p.battle_id = battles.id and public.is_self(p.user_id)
  ));
-- Allow lobby/discovery: any authenticated user can browse queued battles before joining.
create policy battles_select_queued on public.battles for select to authenticated
  using (status = 'queued');

create table public.battle_rounds (
  id              uuid primary key default gen_random_uuid(),
  battle_id       uuid not null references public.battles(id) on delete cascade,
  round_no        smallint not null check (round_no >= 0),
  payload         jsonb not null default '{}'::jsonb,
  winner_user_id  uuid references public.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  unique (battle_id, round_no)
);
create index battle_rounds_battle_idx on public.battle_rounds (battle_id);
create index battle_rounds_winner_idx on public.battle_rounds (winner_user_id);
alter table public.battle_rounds enable row level security;
create policy battle_rounds_select_participants on public.battle_rounds for select to authenticated
  using (exists (
    select 1 from public.battle_participants p
    where p.battle_id = battle_rounds.battle_id and public.is_self(p.user_id)
  ));

create table public.trivia_questions (
  id                   uuid primary key default gen_random_uuid(),
  category             text not null,
  prompt               text not null,
  choices              jsonb not null,
  correct_index        smallint not null check (correct_index >= 0),
  difficulty           smallint not null check (difficulty between 1 and 10),
  source_url           text,
  verified             boolean not null default false,
  verified_by_user_id  uuid references public.users(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index trivia_q_cat_diff_verified_idx on public.trivia_questions (category, difficulty, verified);
create index trivia_q_verified_idx          on public.trivia_questions (verified);
create trigger trivia_q_set_updated_at before update on public.trivia_questions
  for each row execute function public.set_updated_at();
alter table public.trivia_questions enable row level security;
create policy trivia_q_select_verified on public.trivia_questions for select to authenticated
  using (verified = true);

create table public.trivia_answers (
  id            uuid primary key default gen_random_uuid(),
  battle_id     uuid not null references public.battles(id)        on delete cascade,
  round_id      uuid not null references public.battle_rounds(id)  on delete cascade,
  user_id       uuid not null references public.users(id)          on delete cascade,
  question_id   uuid not null references public.trivia_questions(id) on delete restrict,
  chosen_index  smallint not null check (chosen_index >= 0),
  correct       boolean not null,
  latency_ms    integer not null check (latency_ms >= 0),
  created_at    timestamptz not null default now()
);
create index trivia_a_battle_idx   on public.trivia_answers (battle_id);
create index trivia_a_round_idx    on public.trivia_answers (round_id);
create index trivia_a_user_idx     on public.trivia_answers (user_id);
create index trivia_a_question_idx on public.trivia_answers (question_id);
alter table public.trivia_answers enable row level security;
-- INSERT performed by service-role only (game server records the answer with verified
-- correctness and latency_ms it observed). Clients only read their own answers.
create policy trivia_a_select_self on public.trivia_answers for select to authenticated
  using (public.is_self(user_id));

commit;

-- Down (reference):
--   drop table public.trivia_answers, public.trivia_questions,
--              public.battle_rounds, public.battle_participants, public.battles cascade;
