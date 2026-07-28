// Tribe-placement quiz — pure content + scoring. No React, no network, so the
// resolver is unit-testable in isolation. Design + verification table live in
// docs/TRIBE_OVERHAUL_PLAN.md. Slugs must match the seed (migration
// 20260718120000_reseed_seven_tribes).
//
// 5 axes (all full-weight): ECON = market vs collective; SOCIAL = tradition vs
// progress; ESTAB = anti-establishment vs institutionalist; STATE = individual
// liberty vs strong state over the person; NATION = cosmopolitan vs nation-first.
// Options never name a tribe and axis scores are hidden from the user — placement
// stays viewpoint-neutral (VISION §7).
//
// Flow: 13 core questions place a vector, then a TERMINAL two-bank tie-breaker for
// the only two pairs that geometrically bleed (Progressive/Liberal, Populist/
// Nationalist). A bank fires once, resolves that pair by a direct vote, and is
// final — the 7-way resolution never re-runs (no border cascade). Everything else
// that is ambiguous or near-neutral opens the mandatory all-seven override.

export type Axis = 'ECON' | 'SOCIAL' | 'ESTAB' | 'STATE' | 'NATION';
export type AxisScores = Partial<Record<Axis, number>>;

const AXES: readonly Axis[] = ['ECON', 'SOCIAL', 'ESTAB', 'STATE', 'NATION'];

export interface QuizOption {
  readonly label: string;
  readonly scores: AxisScores;
}

export interface QuizQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly options: readonly QuizOption[];
}

// Core questions. Coverage: ECON ×3, SOCIAL ×3, ESTAB ×3, STATE ×2, NATION ×2.
// Option order is load-bearing — the canonical answer keys in the resolver test
// address options by index. Per-question option scores:
//   ECON / SOCIAL / NATION : idx0 = +2, idx1 = 0, idx2 = -2
//   ESTAB                  : idx0 = -2, idx1 = 0, idx2 = +2
//   STATE                  : idx0 = -2, idx1 = 0, idx2 = +1  (no tribe sits past
//                            +1, so the authority pole is scored +1, not +2)
export const CORE_QUESTIONS: readonly QuizQuestion[] = [
  // ---- ECON: market (-) vs collective (+) ----
  {
    id: 'econ-factory-sale',
    prompt: 'The factory that runs your town is up for sale. Who should own it?',
    options: [
      {
        label: 'The workers who run it. The people who build the value should hold it.',
        scores: { ECON: 2 },
      },
      {
        label: 'Whoever wins it on a fair, open sale, with workers free to bid.',
        scores: { ECON: 0 },
      },
      {
        label: 'The highest bidder. The market puts it in the best hands.',
        scores: { ECON: -2 },
      },
    ],
  },
  {
    id: 'econ-wealth-gap',
    prompt: 'A handful of people now own more than half the country combined.',
    options: [
      {
        label: 'Rigged. Wealth stacked that high is bought rules, not earned reward.',
        scores: { ECON: 2 },
      },
      {
        label: 'Some gap rewards effort; the job is stopping it from hardening into a wall.',
        scores: { ECON: 0 },
      },
      {
        label: "So what? Wealth isn't a fixed pie. Someone gaining doesn't mean you lost.",
        scores: { ECON: -2 },
      },
    ],
  },
  {
    id: 'econ-new-industry',
    prompt:
      'A new industry is booming. Should the public help steer where it grows, or leave it to the market?',
    options: [
      {
        label: 'Steer it. Public direction makes sure the gains reach everyone, not just owners.',
        scores: { ECON: 2 },
      },
      {
        label: 'Set fair rules, then let firms and workers sort out the rest.',
        scores: { ECON: 0 },
      },
      { label: 'Leave it. Planners guess; markets discover.', scores: { ECON: -2 } },
    ],
  },
  // ---- SOCIAL: tradition (-) vs progress (+) ----
  {
    id: 'social-new-generation',
    prompt:
      'A new generation wants to rewrite the old rules on family, faith, and how people are expected to live.',
    options: [
      {
        label: 'Good. Every generation should be free to write its own way of living.',
        scores: { SOCIAL: 2 },
      },
      {
        label: "Some old norms earned their place, some didn't. Sort them one by one.",
        scores: { SOCIAL: 0 },
      },
      {
        label:
          'Faith and family are the ground people stand on. Rewrite them and you get rootlessness.',
        scores: { SOCIAL: -2 },
      },
    ],
  },
  {
    id: 'social-monument',
    prompt:
      'A monument the town has honored for a century now offends many of the people who live there.',
    options: [
      {
        label: "Take it down. Honoring the past shouldn't mean being ruled by it.",
        scores: { SOCIAL: 2 },
      },
      { label: "Add the full story beside it. Don't erase, don't freeze.", scores: { SOCIAL: 0 } },
      {
        label: 'It stays. A people that tears down its own memory loses its balance.',
        scores: { SOCIAL: -2 },
      },
    ],
  },
  {
    id: 'social-old-custom',
    prompt:
      'A custom your community has kept for generations no longer fits how people actually live.',
    options: [
      {
        label: "Customs should move as people do. A tradition that excludes isn't sacred.",
        scores: { SOCIAL: 2 },
      },
      {
        label: "Keep what still serves, retire what doesn't, judge each on its merits.",
        scores: { SOCIAL: 0 },
      },
      {
        label: 'Keep it. Inherited wisdom outlasts the mood of any single year.',
        scores: { SOCIAL: -2 },
      },
    ],
  },
  // ---- ESTAB: anti-establishment (-) vs institutionalist (+) ----
  {
    id: 'estab-experts',
    prompt: 'The official expert panel rules one way. The packed town hall wants the opposite.',
    options: [
      {
        label: 'Go with the room. Experts protect their own standing before they protect you.',
        scores: { ESTAB: -2 },
      },
      {
        label: 'Hear both out. Judge the case on its merits, not on who is speaking.',
        scores: { ESTAB: 0 },
      },
      {
        label: "Trust the panel. They actually studied it; a crowd's certainty isn't knowledge.",
        scores: { ESTAB: 2 },
      },
    ],
  },
  {
    id: 'estab-insider-rule',
    prompt: 'A rule sails through, written by the same insiders it happens to benefit.',
    options: [
      {
        label: "That's the whole game. The establishment writes the rules to keep itself on top.",
        scores: { ESTAB: -2 },
      },
      {
        label: "A bad rule, sure, but one insider deal doesn't prove the whole thing is bought.",
        scores: { ESTAB: 0 },
      },
      {
        label: "One bad rule isn't proof it's all rigged. Institutions earn trust over time.",
        scores: { ESTAB: 2 },
      },
    ],
  },
  {
    id: 'estab-institution-failure',
    prompt: 'A respected institution is caught in a serious failure it tried to hide.',
    options: [
      {
        label: 'Burn the deference. If that one hid it, they all run on reputation, not merit.',
        scores: { ESTAB: -2 },
      },
      {
        label: 'Account for the failure and fix what allowed it, without torching the rest.',
        scores: { ESTAB: 0 },
      },
      {
        label: "Failure is when the rules matter most. Don't torch what works over one breach.",
        scores: { ESTAB: 2 },
      },
    ],
  },
  // ---- STATE: individual liberty (-) vs strong state over the person (+) ----
  {
    id: 'state-surveillance',
    prompt:
      'After a shock, the government could make everyone safer by watching everyone more closely.',
    options: [
      {
        label: 'No. A state strong enough to protect you is strong enough to own you.',
        scores: { STATE: -2 },
      },
      {
        label: 'Some tools, with hard limits and oversight, sunset when the threat passes.',
        scores: { STATE: 0 },
      },
      {
        label:
          "Take the protection. A society that can't keep its people safe can't keep them free.",
        scores: { STATE: 1 },
      },
    ],
  },
  {
    id: 'state-mandate',
    prompt: 'The government proposes a year of national service required of every young citizen.',
    options: [
      {
        label: "No. A year of your life is yours to give, not the state's to take.",
        scores: { STATE: -2 },
      },
      {
        label: 'Only if the case is real and the burden falls fairly on everyone.',
        scores: { STATE: 0 },
      },
      {
        label: 'Fair enough. Some duties we owe in common, and the state can ask them.',
        scores: { STATE: 1 },
      },
    ],
  },
  // ---- NATION: cosmopolitan (-) vs nation-first (+) ----
  {
    id: 'nation-supranational',
    prompt: "A powerful international body issues a ruling your country's own voters would reject.",
    options: [
      {
        label: 'Our laws are ours to make. No distant body no one elected overrides our vote.',
        scores: { NATION: 2 },
      },
      { label: 'Cooperate where it pays, but keep the final say at home.', scores: { NATION: 0 } },
      {
        label: 'Big problems cross borders. Shared rules beat every nation going it alone.',
        scores: { NATION: -2 },
      },
    ],
  },
  {
    id: 'nation-spend-home',
    prompt:
      'Your country can spend on its own struggling regions or on a greater good beyond its borders.',
    options: [
      {
        label: 'Home first. A nation owes its own citizens before anyone else.',
        scores: { NATION: 2 },
      },
      { label: "Care starts at home, but it doesn't stop at the border.", scores: { NATION: 0 } },
      {
        label: "A person in need is a person in need. Lines on a map don't change that.",
        scores: { NATION: -2 },
      },
    ],
  },
];

export interface TribeTarget {
  readonly slug: string;
  readonly ECON: number;
  readonly SOCIAL: number;
  readonly ESTAB: number;
  readonly STATE: number;
  readonly NATION: number;
}

/** Normalized tribe coordinates (raw ÷ 2). Slugs match the seed. */
export const TRIBE_TARGETS: readonly TribeTarget[] = [
  { slug: 'progressive', ECON: 0.5, SOCIAL: 1.0, ESTAB: 0.5, STATE: 0.5, NATION: -0.5 },
  { slug: 'socialist', ECON: 1.0, SOCIAL: 0.5, ESTAB: -0.5, STATE: 0.5, NATION: -0.5 },
  { slug: 'liberal', ECON: 0.0, SOCIAL: 0.5, ESTAB: 1.0, STATE: 0.0, NATION: -0.5 },
  { slug: 'conservative', ECON: -0.5, SOCIAL: -1.0, ESTAB: 0.5, STATE: 0.0, NATION: 0.5 },
  { slug: 'libertarian', ECON: -1.0, SOCIAL: 0.5, ESTAB: -0.5, STATE: -1.0, NATION: -0.5 },
  { slug: 'populist', ECON: 0.0, SOCIAL: -0.5, ESTAB: -1.0, STATE: 0.0, NATION: 0.5 },
  { slug: 'nationalist', ECON: 0.0, SOCIAL: -1.0, ESTAB: -0.5, STATE: 0.5, NATION: 1.0 },
];

// Normalization divisors = (questions on that axis) × 2, i.e. max achievable
// |raw|. STATE's positive options cap at +1, but its negative extreme is -4
// (two -2s), so 4 is the correct magnitude divisor. Weights are equal (1.0) —
// the §-analog verification clears without a supporting-axis discount.
const DIVISOR: Record<Axis, number> = { ECON: 6, SOCIAL: 6, ESTAB: 6, STATE: 4, NATION: 4 };
const WEIGHT: Record<Axis, number> = { ECON: 1, SOCIAL: 1, ESTAB: 1, STATE: 1, NATION: 1 };

// Below this margin between the top two tribes the placement is ambiguous; below
// this user-vector magnitude it is near-neutral. Both open the override (unless an
// ambiguous top-two is one of the wired tie-breaker pairs).
export const BORDER_MARGIN = 0.2;
export const MAG_MIN = 0.4;

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

export type TiebreakKey = 'prog-lib' | 'pop-nat';

export interface TiebreakOption {
  readonly label: string;
  /** Slug this option votes for (one of the pair). */
  readonly vote: string;
}

export interface TiebreakQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly options: readonly TiebreakOption[];
}

export interface TiebreakBank {
  readonly pair: readonly [string, string];
  readonly questions: readonly TiebreakQuestion[];
}

// Terminal runoff banks. Each option is a direct vote for one tribe of the pair;
// the majority wins (ties fall back to the core pass's nearer tribe). Fired at
// most once — see resolveTiebreak.
export const TIEBREAK_BANKS: Record<TiebreakKey, TiebreakBank> = {
  'prog-lib': {
    pair: ['progressive', 'liberal'],
    questions: [
      {
        id: 'pl-pace',
        prompt: 'You agree the economy is unfair. The question is how far to go.',
        options: [
          {
            label: 'Structural change. Half-measures are how it stayed unfair this long.',
            vote: 'progressive',
          },
          {
            label: "Steady reform. Don't burn down what works chasing what might.",
            vote: 'liberal',
          },
        ],
      },
      {
        id: 'pl-institutions',
        prompt: 'The institutions are flawed but standing. Work through them, or remake them?',
        options: [
          {
            label: 'Remake them. Loyalty to a broken institution just protects what it does wrong.',
            vote: 'progressive',
          },
          {
            label: 'Work through them. The guardrails are the achievement; mend them from inside.',
            vote: 'liberal',
          },
        ],
      },
      {
        id: 'pl-procedure',
        prompt: 'A reform you believe in could move faster if you bent one procedure to do it.',
        options: [
          {
            label: "Results matter. Don't let procedure shield a bad status quo.",
            vote: 'progressive',
          },
          {
            label: 'Never. The moment you skip due process, you have become the problem.',
            vote: 'liberal',
          },
        ],
      },
    ],
  },
  'pop-nat': {
    pair: ['populist', 'nationalist'],
    questions: [
      {
        id: 'pn-grievance',
        prompt: 'Something has gone badly wrong for ordinary people. Where does the blame sit?',
        options: [
          {
            label: 'The insiders at the top. Elites who rigged the game against their own people.',
            vote: 'populist',
          },
          {
            label:
              "Forces from outside. Powers beyond our borders we never chose and can't vote out.",
            vote: 'nationalist',
          },
        ],
      },
      {
        id: 'pn-strong-state',
        prompt: "To set things right, how much power should the nation's government take?",
        options: [
          {
            label:
              'Enough to defend the country and its way of life. A strong state for a strong nation.',
            vote: 'nationalist',
          },
          {
            label:
              'Power to the people, not a bigger machine. Every state grows to serve its own insiders.',
            vote: 'populist',
          },
        ],
      },
    ],
  },
};

export interface CoreResolution {
  /** Nearest tribe's slug from the core pass. */
  readonly best: string;
  /** Second-nearest tribe's slug. */
  readonly runnerUp: string;
  /** d² gap between runner-up and best (larger = more confident). */
  readonly margin: number;
  /** Magnitude of the user vector (small = near-neutral answers). */
  readonly magnitude: number;
  /** True when the placement is confident (no branch, no override). */
  readonly confident: boolean;
  /** Which tie-breaker bank to fire, when the ambiguous pair is a wired one. */
  readonly branch: TiebreakKey | null;
  /** True when the UI should open on the all-seven override instead. */
  readonly showOverride: boolean;
}

function branchFor(a: string, b: string): TiebreakKey | null {
  const pair = new Set([a, b]);
  for (const key of Object.keys(TIEBREAK_BANKS) as TiebreakKey[]) {
    const [x, y] = TIEBREAK_BANKS[key].pair;
    if (pair.has(x) && pair.has(y)) return key;
  }
  return null;
}

/**
 * Resolve the 13 core answers (option indices, in CORE_QUESTIONS order) into a
 * placement decision. Missing/out-of-range answers are ignored. Does NOT ask the
 * tie-breaker — it returns `branch` so the UI knows which bank to run next.
 */
export function resolveCore(answers: readonly number[]): CoreResolution {
  const raw: Record<Axis, number> = { ECON: 0, SOCIAL: 0, ESTAB: 0, STATE: 0, NATION: 0 };
  answers.forEach((optionIndex, questionIndex) => {
    const option = CORE_QUESTIONS[questionIndex]?.options[optionIndex];
    if (!option) return;
    for (const axis of AXES) raw[axis] += option.scores[axis] ?? 0;
  });

  const v = {} as Record<Axis, number>;
  for (const axis of AXES) v[axis] = clamp(raw[axis] / DIVISOR[axis], -1, 1);

  const ranked = TRIBE_TARGETS.map((t) => ({
    slug: t.slug,
    d2: AXES.reduce((sum, axis) => sum + WEIGHT[axis] * (v[axis] - t[axis]) ** 2, 0),
  })).sort((p, q) => p.d2 - q.d2);

  const best = ranked[0]!;
  const second = ranked[1]!;
  const margin = second.d2 - best.d2;
  const magnitude = Math.sqrt(AXES.reduce((sum, axis) => sum + v[axis] ** 2, 0));

  const base = { best: best.slug, runnerUp: second.slug, margin, magnitude };

  if (magnitude < MAG_MIN) {
    return { ...base, confident: false, branch: null, showOverride: true };
  }
  if (margin >= BORDER_MARGIN) {
    return { ...base, confident: true, branch: null, showOverride: false };
  }
  const branch = branchFor(best.slug, second.slug);
  return { ...base, confident: false, branch, showOverride: branch === null };
}

/**
 * Terminal runoff. Tally the bank votes and return the winning tribe of the pair.
 * A tie falls back to `coreBest` (the core pass's nearer of the two). The 7-way
 * resolution is never re-run, so there is no border cascade.
 */
export function resolveTiebreak(
  branch: TiebreakKey,
  tiebreakAnswers: readonly number[],
  coreBest: string,
): string {
  const bank = TIEBREAK_BANKS[branch];
  const tally: Record<string, number> = {};
  tiebreakAnswers.forEach((optionIndex, questionIndex) => {
    const option = bank.questions[questionIndex]?.options[optionIndex];
    if (!option) return;
    tally[option.vote] = (tally[option.vote] ?? 0) + 1;
  });

  const [a, b] = bank.pair;
  const va = tally[a] ?? 0;
  const vb = tally[b] ?? 0;
  if (va > vb) return a;
  if (vb > va) return b;
  return bank.pair.includes(coreBest) ? coreBest : a;
}
