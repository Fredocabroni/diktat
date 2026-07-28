// Tribe-placement quiz — pure content + scoring. No React, no network, so the
// resolver is unit-testable in isolation. Design + verification live in
// docs/TRIBE_OVERHAUL_PLAN.md (§7). Slugs match the seed (migration
// 20260718120000_reseed_seven_tribes).
//
// Rev 2: concrete ISSUE questions (the Pew approach) instead of abstract-axis
// framing. 12 single-axis issue questions load onto the same 5 axes and 7 tribe
// coordinates; only what the questions measure changed. Forced-choice: some
// questions are binary (where a middle is a dodge), some 3-option (where a tribe
// genuinely lives at the midpoint). Guns and foreign policy carry MODERATE (±1)
// deltas so they tip only the extremes, not partisan gun-culture / anti-war.
//
// Axes: ECON = market vs collective; SOCIAL = tradition vs progress; ESTAB =
// anti-establishment vs institutionalist; STATE = individual liberty vs strong
// state over the person; NATION = cosmopolitan vs nation-first. Options never name
// a tribe and axis scores are hidden (viewpoint-neutral, VISION §7).
//
// Twins: concrete issues cleanly separate 4 tribes but collapse 3 issue-twin pairs
// (they answer loud issues alike, differ only by intensity/temperament). Each gets
// a terminal 2-question runoff. IMPORTANT (see §7.2): an anti-establishment
// issue-conservative resolves to Populist BY DESIGN — ESTAB is a primary placement
// dimension, not a secondary flavor. Do not down-weight ESTAB to "rescue" them.

export type Axis = 'ECON' | 'SOCIAL' | 'ESTAB' | 'STATE' | 'NATION';
export type AxisScores = Partial<Record<Axis, number>>;

const AXES: readonly Axis[] = ['ECON', 'SOCIAL', 'ESTAB', 'STATE', 'NATION'];

/** Shown once at the top of the quiz — the Pew forced-choice framing. */
export const QUIZ_INTRO = 'Pick the answer closest to your view, even if neither is exactly right.';

export interface QuizOption {
  readonly label: string;
  readonly scores: AxisScores;
}

export interface QuizQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly options: readonly QuizOption[];
}

// 12 core issue questions. Coverage: ECON ×3, SOCIAL ×3, STATE ×2, NATION ×2,
// ESTAB ×2. Binary questions (taxes, immigration, both ESTAB) have 2 options;
// the rest have 3 with a genuine on-axis midpoint. Option order is load-bearing —
// the canonical answer keys in the resolver test address options by index.
export const CORE_QUESTIONS: readonly QuizQuestion[] = [
  // ---- ECON: market (-) vs collective (+) ----
  {
    id: 'econ-taxes',
    prompt: 'The country is deciding whether to raise taxes on its wealthiest.',
    options: [
      {
        label:
          'Raise them. Concentrated wealth should pay back into the country that made it possible.',
        scores: { ECON: 2 },
      },
      {
        label:
          'Cut them. People earned that money, and they spend it better than any government will.',
        scores: { ECON: -2 },
      },
    ],
  },
  {
    id: 'econ-healthcare',
    prompt: 'How should the country handle healthcare?',
    options: [
      {
        label: 'Guarantee it for everyone through government. Health is a right, not a market.',
        scores: { ECON: 2 },
      },
      {
        label:
          'Mix both. A public safety net for those who need it, private choice for those who want it.',
        scores: { ECON: 0 },
      },
      {
        label:
          'Keep it private and competitive. Government control means worse care and longer waits.',
        scores: { ECON: -2 },
      },
    ],
  },
  {
    id: 'econ-welfare',
    prompt: 'A neighbor has been on government assistance for years.',
    options: [
      {
        label: 'Fund it without shame. A decent society catches people before they hit the ground.',
        scores: { ECON: 2 },
      },
      {
        label: 'A ladder, not a hammock. Help that expects a real path back to work.',
        scores: { ECON: 0 },
      },
      {
        label:
          'Shrink it. Aid that never ends traps people in dependence instead of lifting them out.',
        scores: { ECON: -2 },
      },
    ],
  },
  // ---- SOCIAL: tradition (-) vs progress (+) ----
  {
    id: 'social-abortion',
    prompt: 'Where should the law land on abortion?',
    options: [
      {
        label: "Her body, her call. A woman's right to decide her own life comes first.",
        scores: { SOCIAL: 2 },
      },
      {
        label:
          'Legal but limited. Allowed early, real limits later, the way most people actually feel.',
        scores: { SOCIAL: 0 },
      },
      {
        label:
          'Protect the unborn. A society is judged by how it guards its most defenseless lives.',
        scores: { SOCIAL: -2 },
      },
    ],
  },
  {
    id: 'social-lgbtq',
    prompt: 'How should the country treat questions of gender and sexuality?',
    options: [
      {
        label:
          "Full equality, full stop. Who you love and who you are is nobody's business but yours.",
        scores: { SOCIAL: 2 },
      },
      {
        label:
          'Live and let live. Equal treatment for everyone, and no one made to celebrate or condemn.',
        scores: { SOCIAL: 0 },
      },
      {
        label: 'Hold to tradition. Marriage and the two sexes are foundations, not fashions.',
        scores: { SOCIAL: -2 },
      },
    ],
  },
  {
    id: 'social-religion',
    prompt: 'What place should faith have in public life?',
    options: [
      {
        label: 'A central one. A country cut off from its faith and moral roots loses its compass.',
        scores: { SOCIAL: -2 },
      },
      {
        label: 'A personal one. Believe freely, but the public square should work for everyone.',
        scores: { SOCIAL: 0 },
      },
      {
        label: 'A private one. Government and law should be strictly secular, no exceptions.',
        scores: { SOCIAL: 2 },
      },
    ],
  },
  // ---- STATE: individual liberty (-) vs strong state over the person (+). Moderate deltas on guns. ----
  {
    id: 'state-guns',
    prompt: 'The government wants to tighten who can legally own a gun.',
    options: [
      {
        label: 'Back off. An armed citizen is a free citizen, and a check on government overreach.',
        scores: { STATE: -1 },
      },
      {
        label: 'Reasonable limits. Keep the right, but screen out the dangerous with real checks.',
        scores: { STATE: 0 },
      },
      {
        label: 'Lock it down. Fewer guns, stronger rules, fewer funerals. Safety comes first.',
        scores: { STATE: 1 },
      },
    ],
  },
  {
    id: 'state-crime',
    prompt: "Crime is climbing in a major city. What's the answer?",
    options: [
      {
        label:
          'More police, tougher sentences. Order is the first thing a government owes its people.',
        scores: { STATE: 2 },
      },
      {
        label: 'Back the police, and fix what drives people to crime in the first place.',
        scores: { STATE: 0 },
      },
      {
        label:
          'Attack the roots. Opportunity and fair policing prevent more crime than force and fear ever will.',
        scores: { STATE: -2 },
      },
    ],
  },
  // ---- NATION: cosmopolitan (-) vs nation-first (+). Moderate deltas on foreign policy. ----
  {
    id: 'nation-immigration',
    prompt: 'How should the country handle immigration?',
    options: [
      {
        label:
          "Secure the border and enforce the law. A nation that can't control who enters isn't sovereign.",
        scores: { NATION: 2 },
      },
      {
        label:
          'Open the door. Immigrants renew this country, and a fair, humane system beats a wall.',
        scores: { NATION: -2 },
      },
    ],
  },
  {
    id: 'nation-foreign',
    prompt: "What should drive the country's role in the world?",
    options: [
      {
        label:
          'Our own interests first. Stop policing the globe and let allies carry their own weight.',
        scores: { NATION: 1 },
      },
      {
        label:
          "Strength with judgment. Lead where it truly serves us, and stay out where it doesn't.",
        scores: { NATION: 0 },
      },
      {
        label:
          'Stand with our allies and our values. Retreat just leaves a vacuum worse powers fill.',
        scores: { NATION: -1 },
      },
    ],
  },
  // ---- ESTAB: anti-establishment (-) vs institutionalist (+). Both binary, primary dimension (§7.2). ----
  {
    id: 'estab-experts',
    prompt:
      "The experts and official institutions say one thing; a lot of ordinary people don't buy it.",
    options: [
      {
        label:
          "Trust the people. The experts too often serve whoever pays them, and face no consequences when they're wrong.",
        scores: { ESTAB: -2 },
      },
      {
        label:
          "Trust the process. Expertise gets tested, challenged, and corrected in the open. That's what earns deference.",
        scores: { ESTAB: 2 },
      },
    ],
  },
  {
    id: 'estab-elites',
    prompt: 'Is the system basically rigged?',
    options: [
      {
        label:
          'Yes. A donor-and-insider class runs the system for itself and leaves everyone else the bill.',
        scores: { ESTAB: -2 },
      },
      {
        label:
          'No. It has real flaws, but the institutions are legitimate and worth defending and repairing.',
        scores: { ESTAB: 2 },
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

/** Normalized tribe coordinates (raw ÷ 2). Slugs match the seed. Unchanged from rev 1. */
export const TRIBE_TARGETS: readonly TribeTarget[] = [
  { slug: 'progressive', ECON: 0.5, SOCIAL: 1.0, ESTAB: 0.5, STATE: 0.5, NATION: -0.5 },
  { slug: 'socialist', ECON: 1.0, SOCIAL: 0.5, ESTAB: -0.5, STATE: 0.5, NATION: -0.5 },
  { slug: 'liberal', ECON: 0.0, SOCIAL: 0.5, ESTAB: 1.0, STATE: 0.0, NATION: -0.5 },
  { slug: 'conservative', ECON: -0.5, SOCIAL: -1.0, ESTAB: 0.5, STATE: 0.0, NATION: 0.5 },
  { slug: 'libertarian', ECON: -1.0, SOCIAL: 0.5, ESTAB: -0.5, STATE: -1.0, NATION: -0.5 },
  { slug: 'populist', ECON: 0.0, SOCIAL: -0.5, ESTAB: -1.0, STATE: 0.0, NATION: 0.5 },
  { slug: 'nationalist', ECON: 0.0, SOCIAL: -1.0, ESTAB: -0.5, STATE: 0.5, NATION: 1.0 },
];

// Normalization divisors = max achievable |raw| per axis. ECON/SOCIAL: 3 Qs × 2 =
// 6. STATE: guns(±1) + crime(±2) = 3. NATION: immigration(±2) + foreign(±1) = 3.
// ESTAB: 2 Qs × 2 = 4. Weights equal (1.0) — ESTAB is deliberately primary (§7.2).
const DIVISOR: Record<Axis, number> = { ECON: 6, SOCIAL: 6, ESTAB: 4, STATE: 3, NATION: 3 };
const WEIGHT: Record<Axis, number> = { ECON: 1, SOCIAL: 1, ESTAB: 1, STATE: 1, NATION: 1 };

// Below this margin the top-two are ambiguous; below this magnitude the vector is
// near-neutral. Nationalist self-places at margin 0.33, so the border sits under it.
export const BORDER_MARGIN = 0.25;
export const MAG_MIN = 0.4;

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

export type TiebreakKey = 'prog-soc' | 'pop-nat' | 'con-pop';

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

// Terminal runoff banks — one per issue-twin collapse. Each option is a direct
// vote for one tribe of the pair; majority wins, ties fall back to the core lean.
export const TIEBREAK_BANKS: Record<TiebreakKey, TiebreakBank> = {
  'prog-soc': {
    pair: ['progressive', 'socialist'],
    questions: [
      {
        id: 'ps-fix',
        prompt: 'The economy is rigged against ordinary people. What is the fix?',
        options: [
          {
            label:
              'Reform it. Tax the top, regulate hard, and expand the safety net until it works for everyone.',
            vote: 'progressive',
          },
          {
            label:
              'Replace it. The problem is the system itself, and the people who do the work should own it.',
            vote: 'socialist',
          },
        ],
      },
      {
        id: 'ps-how',
        prompt: 'And how does that change actually happen?',
        options: [
          {
            label:
              'Through the institutions. Win elections, write the laws, fix it from the inside.',
            vote: 'progressive',
          },
          {
            label:
              'Through movements. The institutions answer to capital; real power is organized from outside.',
            vote: 'socialist',
          },
        ],
      },
    ],
  },
  'pop-nat': {
    pair: ['populist', 'nationalist'],
    questions: [
      {
        id: 'pn-blame',
        prompt: 'Ordinary people are getting a raw deal. Who is really to blame?',
        options: [
          {
            label:
              'The insiders at the top. A corrupt elite that rigged the game and sold everyone else out.',
            vote: 'populist',
          },
          {
            label: 'Forces from outside. Open borders and global powers hollowing out the nation.',
            vote: 'nationalist',
          },
        ],
      },
      {
        id: 'pn-fight',
        prompt: 'So what are you really fighting for?',
        options: [
          { label: 'Power back in the hands of the people, against any elite.', vote: 'populist' },
          {
            label: 'A strong, sovereign nation with borders and an identity worth defending.',
            vote: 'nationalist',
          },
        ],
      },
    ],
  },
  'con-pop': {
    pair: ['conservative', 'populist'],
    questions: [
      {
        id: 'cp-institutions',
        prompt: 'The institutions are failing. What do they need?',
        options: [
          {
            label:
              "Repair, not ruin. They're flawed, but they hold the country together. Fix them from within.",
            vote: 'conservative',
          },
          {
            label:
              'Rebuild, not patch. Some institutions are too captured to reform, and patching one just shields a rigged system.',
            vote: 'populist',
          },
        ],
      },
      {
        id: 'cp-system',
        prompt: 'Be honest about the system as a whole.',
        options: [
          {
            label: "Real problems, but it's legitimate and worth conserving.",
            vote: 'conservative',
          },
          {
            label: 'Rigged to the core by a self-dealing class, and everyone knows it.',
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
  /** True when the placement is confident (no runoff, no override). */
  readonly confident: boolean;
  /** Which runoff bank to fire, when the ambiguous nearest-two is a wired pair. */
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
 * Resolve the 12 core answers (option indices, in CORE_QUESTIONS order) into a
 * placement decision. Missing/out-of-range answers are ignored. Returns `branch`
 * so the UI knows which runoff to run next; the 7-way resolution never re-runs.
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
 * resolution is never re-run, so there is no cascade.
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
