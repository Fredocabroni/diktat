-- Migration: news topics, opinion shifts, AP-only predictions, fact-checks, clips
-- Up:   news_topics first, then attach battles.topic_id FK, then opinion_shifts,
--       predictions, fact_checks, clips. AP-only stakes.
-- Down: drop in reverse FK order; drop battles.topic_id FK first.

begin;

create table public.news_topics (
  id                  uuid primary key default gen_random_uuid(),
  slug                citext not null unique,
  headline            text not null,
  summary             text,
  primary_source_url  text,
  category            text,
  published_at        timestamptz,
  drop_at             timestamptz,
  is_drop             boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index news_topics_drop_at_idx  on public.news_topics (drop_at);
create index news_topics_category_idx on public.news_topics (category);
create trigger news_topics_set_updated_at before update on public.news_topics
  for each row execute function public.set_updated_at();
alter table public.news_topics enable row level security;
create policy news_topics_select_all on public.news_topics for select to anon, authenticated using (true);

alter table public.battles
  add constraint battles_topic_id_fkey
  foreign key (topic_id) references public.news_topics(id) on delete set null;
create index battles_topic_id_idx on public.battles (topic_id);

create table public.opinion_shifts (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.users(id)       on delete cascade,
  topic_id         uuid not null references public.news_topics(id) on delete cascade,
  before_position  smallint not null check (before_position between -2 and 2),
  after_position   smallint not null check (after_position  between -2 and 2),
  created_at       timestamptz not null default now()
);
create index opinion_shifts_user_idx  on public.opinion_shifts (user_id);
create index opinion_shifts_topic_idx on public.opinion_shifts (topic_id);
alter table public.opinion_shifts enable row level security;
-- Append-only: users can record and read their own shifts but never edit or delete prior records
-- (history integrity for tribe leaderboards + opinion-change analytics).
create policy opinion_shifts_select_self on public.opinion_shifts for select to authenticated
  using (public.is_self(user_id));
create policy opinion_shifts_insert_self on public.opinion_shifts for insert to authenticated
  with check (public.is_self(user_id));

create table public.predictions (
  id                  uuid primary key default gen_random_uuid(),
  topic_id            uuid not null references public.news_topics(id) on delete cascade,
  user_id             uuid not null references public.users(id)       on delete cascade,
  market_external_id  text,
  direction           text not null check (direction in ('yes','no')),
  ap_stake            integer not null check (ap_stake > 0),
  ap_payout           integer,
  status              text not null default 'open' check (status in ('open','settled','void')),
  settled_at          timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index predictions_user_status_idx  on public.predictions (user_id, status);
create index predictions_topic_status_idx on public.predictions (topic_id, status);
create trigger predictions_set_updated_at before update on public.predictions
  for each row execute function public.set_updated_at();
alter table public.predictions enable row level security;
create policy predictions_select_self on public.predictions for select to authenticated
  using (public.is_self(user_id));
-- Allow self-stake: authenticated users can place a prediction as themselves at status='open'
-- and ap_payout null. Settlement (status='settled', ap_payout, settled_at) is service-role only.
create policy predictions_insert_self on public.predictions for insert to authenticated
  with check (
    public.is_self(user_id)
    and status = 'open'
    and ap_payout is null
    and settled_at is null
  );

create table public.fact_checks (
  id                    uuid primary key default gen_random_uuid(),
  claim                 text not null,
  topic_id              uuid references public.news_topics(id) on delete set null,
  verdict               text not null check (verdict in ('true','false','misleading','unverified')),
  confidence            numeric(3,2) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  evidence              jsonb not null default '[]'::jsonb,
  provider              text,
  created_by_user_id    uuid references public.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index fact_checks_topic_idx on public.fact_checks (topic_id);
create trigger fact_checks_set_updated_at before update on public.fact_checks
  for each row execute function public.set_updated_at();
alter table public.fact_checks enable row level security;
create policy fact_checks_select_all on public.fact_checks for select to anon, authenticated using (true);

create table public.clips (
  id            uuid primary key default gen_random_uuid(),
  battle_id     uuid not null references public.battles(id) on delete cascade,
  storage_path  text not null,
  duration_ms   integer not null check (duration_ms > 0),
  published     boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index clips_battle_idx    on public.clips (battle_id);
create index clips_published_idx on public.clips (published);
create trigger clips_set_updated_at before update on public.clips
  for each row execute function public.set_updated_at();
alter table public.clips enable row level security;
create policy clips_select_published on public.clips for select to anon, authenticated
  using (published = true);

commit;

-- Down (reference):
--   drop table public.clips, public.fact_checks, public.predictions,
--              public.opinion_shifts cascade;
--   alter table public.battles drop constraint if exists battles_topic_id_fkey;
--   drop index if exists battles_topic_id_idx;
--   drop table public.news_topics cascade;
