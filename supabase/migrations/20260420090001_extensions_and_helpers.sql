-- Migration: extensions + reusable helpers
-- Up:   enable required extensions; install set_updated_at() trigger fn and is_self() RLS helper.
-- Down: drop is_self(), set_updated_at(); leave extensions in place (other migrations may depend on them).

begin;

create extension if not exists pgcrypto with schema extensions;
create extension if not exists citext   with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.set_updated_at() is
  'Trigger fn used by every mutable table to auto-stamp updated_at.';

create or replace function public.is_self(target_user_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select auth.uid() = target_user_id;
$$;

comment on function public.is_self(uuid) is
  'RLS helper. True when the calling JWT subject equals target_user_id.';

commit;
