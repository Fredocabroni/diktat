-- Migration: tribes, tribe memberships, x_posts (drafts queue)
-- Up:   tribes, tribe_memberships (junction), x_posts. Service-role manages x_posts.
-- Down: drop in reverse FK order.

begin;

create table public.tribes (
  id          uuid primary key default gen_random_uuid(),
  slug        extensions.citext not null unique,
  name        text not null,
  description text,
  manifesto   text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger tribes_set_updated_at before update on public.tribes
  for each row execute function public.set_updated_at();
alter table public.tribes enable row level security;
create policy tribes_select_all on public.tribes for select to anon, authenticated using (true);

create table public.tribe_memberships (
  user_id     uuid not null references public.users(id)  on delete cascade,
  tribe_id    uuid not null references public.tribes(id) on delete cascade,
  joined_at   timestamptz not null default now(),
  weekly_ap   integer not null default 0 check (weekly_ap >= 0),
  is_primary  boolean not null default false,
  primary key (user_id, tribe_id)
);
create index tribe_memberships_tribe_weekly_idx on public.tribe_memberships (tribe_id, weekly_ap desc);
create index tribe_memberships_user_idx         on public.tribe_memberships (user_id);
alter table public.tribe_memberships enable row level security;
create policy tribe_memberships_select_all on public.tribe_memberships for select to anon, authenticated using (true);
-- Users can join (insert) and leave (delete) tribes for themselves.
-- weekly_ap is set/incremented by service-role workers (AP engine) — clients cannot mutate it,
-- so no UPDATE policy. New rows must start at weekly_ap = 0 and is_primary = false; the
-- "primary tribe" toggle is also server-managed (one-primary-per-user uniqueness is enforced
-- by the partial unique index above; allowing client-side toggling here would race that index).
create policy tribe_memberships_insert_self on public.tribe_memberships for insert to authenticated
  with check (
    public.is_self(user_id)
    and weekly_ap = 0
    and is_primary = false
  );
create policy tribe_memberships_delete_self on public.tribe_memberships for delete to authenticated
  using (public.is_self(user_id));

create unique index tribe_memberships_one_primary
  on public.tribe_memberships (user_id) where (is_primary);

create table public.x_posts (
  id                uuid primary key default gen_random_uuid(),
  pillar            text not null,
  body              text not null check (length(body) <= 280),
  status            text not null default 'pending' check (status in ('pending','approved','posted','rejected')),
  scheduled_for     timestamptz,
  posted_at         timestamptz,
  external_post_id  text,
  author_user_id    uuid references public.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index x_posts_status_scheduled_idx on public.x_posts (status, scheduled_for);
create trigger x_posts_set_updated_at before update on public.x_posts
  for each row execute function public.set_updated_at();
alter table public.x_posts enable row level security;
-- Reads/writes restricted to service-role; no policies for anon/authenticated.
-- Service-role bypasses RLS, so leaving the policy list empty here is intentional.
-- Belt-and-suspenders: explicitly revoke table privileges from the API roles so a future
-- accidental policy on this table cannot grant access without a deliberate grant.
revoke all on table public.x_posts from anon, authenticated;

commit;

-- Down (reference):
--   drop table public.x_posts, public.tribe_memberships, public.tribes cascade;
