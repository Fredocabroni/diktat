-- Migration: reseed tribes — replace the 5 invented starter tribes with the 7
-- recognizable identities (see docs/TRIBE_OVERHAUL_PLAN.md).
--
-- Up:   wipe tribe_memberships, delete the 5 old tribes, insert the 7 new ones —
--       all in one transaction. Memberships are deleted BEFORE the tribes so the
--       tribe_memberships.tribe_id -> tribes(id) ON DELETE CASCADE never fires on
--       a live membership row. (No real user data exists yet; done correctly
--       regardless.) Copy reviewed by copy-linter: house style, no em-dashes, no
--       MSM framing, no crypto. Nationalist is the strongest LEGITIMATE form
--       (civic, sovereigntist, membership by choice) per the plan's guardrail.
-- Down: reference only (below). Reversible: delete the 7 by slug, re-seed the 5.

begin;

-- 1. Memberships first — never cascade a live row (belt-and-suspenders).
delete from public.tribe_memberships;

-- 2. Retire the 5 invented tribes.
delete from public.tribes
  where slug in ('libertarians', 'populists', 'progressives', 'traditionalists', 'accelerationists');

-- 3. Seed the 7 recognizable tribes. Slugs are load-bearing: the rebuilt
--    onboarding quiz (apps/web/app/onboard/tribe/quiz.ts) resolves to these.
insert into public.tribes (slug, name, description, manifesto)
values
  (
    'progressive',
    'Progressive',
    'Bend the arc forward. The rules were written for a world that''s gone, so rewrite them.',
    'You believe justice is not inherited but built, and every generation owes the next a fairer start than it got. The old arrangements quietly protected whoever wrote them; progress means widening the circle until no one is left standing outside it. Do it through the institutions, not around them, reformed, opened, and made to answer to everyone they touch. You will argue for the excluded against the comfortable, and for the future against the way it has always been.'
  ),
  (
    'socialist',
    'Socialist',
    'The people who build the wealth should own it. Labor before capital.',
    'You believe an economy is just only when the people who do the work hold both the power and the proceeds. Left alone, markets pull wealth upward until a handful own what all of us make; the answer is not charity but ownership, shared, democratic, collective. Solidarity is not a slogan, it is a strategy: what we win, we win together, or we do not win at all. You will argue for labor against capital, and for the many who produce against the few who accumulate.'
  ),
  (
    'liberal',
    'Liberal',
    'Rights, rules, and reason. Fix what''s broken without breaking what works.',
    'You believe the open society is humanity''s hardest-won achievement: individual rights, free markets tempered by a safety net, and institutions built to outlast any one leader. Progress is real, but it comes by reform, not rupture. The rule of law, due process, and the ballot are how a free people change their minds without coming to blows. Defend the guardrails; they are what stands between disagreement and disaster. You will argue for due process against the passions of the moment, and for liberty secured by law against every shortcut around it.'
  ),
  (
    'conservative',
    'Conservative',
    'Keep what works. Family, faith, and the wisdom we inherited.',
    'You believe a society is a covenant between the dead, the living, and the yet unborn, and that the traditions we inherit hold more wisdom than any single clever mind. Family, faith, and community are not relics to be outgrown; they are the load-bearing walls of a free and decent life. Repair what is genuinely broken, slowly and with care, but do not trade a hard-won inheritance for an untested promise. You will argue for continuity against fashion, and for the tested against the merely new.'
  ),
  (
    'libertarian',
    'Libertarian',
    'Your life, your choice. The smallest possible state, the largest possible you.',
    'You believe every person owns their own life, and no majority, agency, or authority may spend it for them. Power coerced is power abused: the state that can grant your freedoms can revoke them, so keep it small and keep it caged. Let people trade, speak, worship, and live as they see fit, and hold them to account only for the harm they actually do. You will argue for the individual against the crowd, and for consent against command.'
  ),
  (
    'populist',
    'Populist',
    'Power belongs to the people, not the insiders who bought it.',
    'You believe a small class of insiders (financiers, officials, and credentialed experts) has captured the decisions that shape ordinary lives and writes the rules to keep itself on top. The divide that matters is not left against right; it is the people against an establishment that manages them and talks down to them. Give the majority back its voice, and trust the hard-earned common sense of the many over the polished consensus of the few. You will argue for the ordinary against the connected, and for the governed against the machine that runs them.'
  ),
  (
    'nationalist',
    'Nationalist',
    'A nation that governs itself. Sovereignty, borders decided at home, and a shared way of life.',
    'You believe a self-governing nation is the largest community in which people still owe one another something real, and the one place where a citizen''s vote actually decides. A people has the right to set its own laws, to choose on its own terms who joins it, and to pass on the language, customs, and memory that make a country a home rather than a marketplace. Self-rule means the decisions that shape your nation are made by its citizens, not ceded to distant bodies that no one elected and no one can vote out. You will argue for the sovereign nation against rule from afar, and for a shared civic inheritance open to all who will join it.'
  );

commit;

-- Down (reference, not auto-run):
--   begin;
--   delete from public.tribe_memberships;
--   delete from public.tribes where slug in (
--     'progressive','socialist','liberal','conservative','libertarian','populist','nationalist'
--   );
--   -- then re-run 20260420090008_seed_starter_tribes.sql to restore the old 5.
--   commit;
