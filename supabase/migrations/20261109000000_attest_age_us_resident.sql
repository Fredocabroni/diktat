-- Migration: US-only gate — add `p_us_resident boolean` to attest_age.
--
-- Pre-launch, Diktat is available to US residents only. The /onboard/age
-- page now shows a required "I'm a US resident" checkbox alongside the
-- date-of-birth input. The attest_age RPC grows a second parameter so
-- the server enforces the invariant even if a crafted PostgREST call
-- bypasses the UI.
--
-- Posture choice: when p_us_resident is false, we RAISE
-- `invalid_parameter_value` (errcode 22023) rather than stamping
-- age_blocked_at. Reasons:
--   1. The UI makes the box required — a legitimate user who intends
--      to proceed cannot submit false. A false value here is either a
--      direct-PostgREST call or a user who deliberately said "I am not
--      in the US" (in which case re-prompting after they correct the
--      box is the humane outcome, not a terminal block).
--   2. The IP-country gate (edge-side, Vercel `x-vercel-ip-country`)
--      is the primary enforcement; this RPC check is defence-in-depth
--      against VPN/header-forgery combined with a crafted call.
--   3. Terminal-block posture is reserved for the <18 case where the
--      operator contract says "no hints about lying". US residency is
--      a factual confirmation, not an age attestation.
--
-- The web client treats BAD_REQUEST on attestAge identically today
-- (red copy, user corrects, re-submits) — no new UX branch required.
--
-- Signature change: DROP + CREATE (not CREATE OR REPLACE). The old
-- single-arg function is dropped. All call sites in this PR pass
-- p_us_resident.
--
-- Up:
--   drop function public.attest_age(date);
--   create function public.attest_age(date, boolean) returns jsonb ...
--   revoke/grant repeated on the new signature.
--
-- Down:
--   drop function public.attest_age(date, boolean);
--   recreate the single-arg function from 20261108000000.

begin;

drop function if exists public.attest_age(date);

create function public.attest_age(p_birth_date date, p_us_resident boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id   uuid := auth.uid();
  v_age       int;
  v_row       public.users%rowtype;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if p_birth_date is null then
    raise exception 'age-gate: birth_date is required'
      using errcode = '22023';  -- invalid_parameter_value
  end if;

  -- Reject nonsense DOBs. A date >= today or absurdly far in the past
  -- is almost certainly a mis-click; raise invalid_parameter_value so
  -- the client can re-prompt instead of mis-stamping blocked. The
  -- `<= '1900-01-01'` floor is well below the oldest known human age.
  if p_birth_date >= current_date or p_birth_date <= date '1900-01-01' then
    raise exception 'age-gate: birth_date out of range'
      using errcode = '22023';
  end if;

  -- US-residency check. Non-terminal: BAD_REQUEST so the client can
  -- re-prompt. Server-side enforcement is defence in depth against a
  -- crafted PostgREST call that bypasses the UI checkbox + the
  -- Vercel-edge IP-country gate.
  if p_us_resident is distinct from true then
    raise exception 'age-gate: us_resident must be true'
      using errcode = '22023';
  end if;

  select * into v_row from public.users where id = v_user_id;
  if not found then
    raise exception 'age-gate: user row missing'
      using errcode = 'P0002';  -- no_data_found
  end if;

  -- Terminal-block guard. Any further attempt by a blocked account
  -- is refused — even an attempt with a 100%-adult DOB + us_resident=true.
  -- The operator contract: "no hints about lying".
  if v_row.age_blocked_at is not null then
    raise exception 'age-gate: no further attempts'
      using errcode = 'P0001';
  end if;

  -- Idempotent no-op for an already-verified row.
  if v_row.age_verified_at is not null then
    return jsonb_build_object('outcome', 'already_verified');
  end if;

  v_age := extract(year from age(current_date, p_birth_date))::int;

  if v_age >= 18 then
    update public.users
       set age_verified_at = now(),
           updated_at      = now()
     where id = v_user_id
       and age_verified_at is null
       and age_blocked_at is null;
    return jsonb_build_object('outcome', 'verified');
  else
    update public.users
       set age_blocked_at = now(),
           updated_at     = now()
     where id = v_user_id
       and age_verified_at is null
       and age_blocked_at is null;
    return jsonb_build_object('outcome', 'blocked');
  end if;
end;
$$;

revoke all on function public.attest_age(date, boolean) from public, anon;
grant execute on function public.attest_age(date, boolean) to authenticated, service_role;

comment on function public.attest_age(date, boolean) is
  'Self-attested 18+ US-resident gate. Caller submits DOB + US-residency '
  'bool; the server validates both and stamps age_verified_at or '
  'age_blocked_at on public.users. Never writes the date of birth. '
  'us_resident=false raises BAD_REQUEST (non-terminal); <18 stamps '
  'blocked (terminal). The /onboard/age page is the sole UI caller.';

commit;
