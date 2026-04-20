-- Migration: seed 5 starter tribes for onboarding.
-- Up:   idempotent INSERT … ON CONFLICT (slug) DO UPDATE for the five
--       starter tribes referenced by /onboard/tribe. Copy reviewed by
--       copy-linter before ship (civic voice, no MSM framing, no crypto).
-- Down: delete by slug (reversible — memberships are not seeded here).

begin;

insert into public.tribes (slug, name, description, manifesto)
values
  (
    'libertarians',
    'Libertarians',
    'Shrink the state. Expand the individual. Voluntary trade, open speech, limited power.',
    'You believe the smallest government is the least dangerous one. Taxation is a tool, not a purpose. Markets coordinate better than committees. You will argue for the individual against the crowd, and for the citizen against the clerk.'
  ),
  (
    'populists',
    'Populists',
    'Power to the people. Suspicion of elites — financial, political, and institutional.',
    'You believe the system is rigged for insiders and written by lobbyists. The working majority pays for decisions made above its head. You will argue for the forgotten against the credentialed, and for the street against the salon.'
  ),
  (
    'progressives',
    'Progressives',
    'A fair shake for everyone. Reform the rules so the next generation starts from a stronger floor.',
    'You believe power without accountability breaks things — wages, climate, dignity. The rules were written before the world we live in, and they need rewriting. You will argue for repair over inertia, and for the future over the ledger.'
  ),
  (
    'traditionalists',
    'Traditionalists',
    'Institutions exist for a reason. Change what is broken; keep what is not.',
    'You believe a society that forgets its roots loses its balance. Family, faith, craft, and country carry weight. You will argue for continuity over fashion, and for the long memory over the loud week.'
  ),
  (
    'accelerationists',
    'Accelerationists',
    'Build fast. Ship the future. Stagnation is the hidden tax.',
    'You believe the cost of slow progress is measured in lives not saved and tools not built. Every delay is a choice. You will argue for the frontier over the committee, and for the prototype over the memo.'
  )
on conflict (slug) do update
  set name        = excluded.name,
      description = excluded.description,
      manifesto   = excluded.manifesto,
      updated_at  = now();

commit;

-- Down (reference, not auto-run):
--   delete from public.tribes where slug in (
--     'libertarians','populists','progressives','traditionalists','accelerationists'
--   );
