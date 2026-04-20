-- Migration: seed the 12 canonical tiers
-- Up:   insert tiers 0..11 with AP bands tuned for ~3 years of dedicated play to Mythic.
-- Down: delete tiers 0..11 (only safe before any users.tier_id references them).

begin;

insert into public.tiers (id, name, ap_min, ap_max, payout_eligible, floor_protected, cosmetics) values
  (0,  'Citizen',     0,      99,     false, true,  '{"hue":"slate"}'::jsonb),
  (1,  'Voter',       100,    299,    false, true,  '{"hue":"sky"}'::jsonb),
  (2,  'Partisan',    300,    749,    false, true,  '{"hue":"teal"}'::jsonb),
  (3,  'Operative',   750,    1499,   true,  true,  '{"hue":"emerald"}'::jsonb),
  (4,  'Strategist',  1500,   2999,   true,  true,  '{"hue":"amber"}'::jsonb),
  (5,  'Tactician',   3000,   5499,   true,  true,  '{"hue":"orange"}'::jsonb),
  (6,  'Vanguard',    5500,   9999,   true,  true,  '{"hue":"rose"}'::jsonb),
  (7,  'Senator',     10000,  17999,  true,  false, '{"hue":"fuchsia"}'::jsonb),
  (8,  'Statesman',   18000,  29999,  true,  false, '{"hue":"violet"}'::jsonb),
  (9,  'Architect',   30000,  46999,  true,  false, '{"hue":"indigo"}'::jsonb),
  (10, 'Legendary',   47000,  74999,  true,  false, '{"hue":"gold"}'::jsonb),
  (11, 'Mythic',      75000,  null,   true,  false, '{"hue":"holo"}'::jsonb)
on conflict (id) do update set
  name             = excluded.name,
  ap_min           = excluded.ap_min,
  ap_max           = excluded.ap_max,
  payout_eligible  = excluded.payout_eligible,
  floor_protected  = excluded.floor_protected,
  cosmetics        = excluded.cosmetics,
  updated_at       = now();

commit;

-- Down (reference): delete from public.tiers where id between 0 and 11;
