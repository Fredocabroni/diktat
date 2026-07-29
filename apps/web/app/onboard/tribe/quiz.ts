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
// ESTAB ×2. ECON is GRADUATED (Fix A): the moderate-left option scores +1, the
// revolutionary-left option +2, so a reformist Democrat nets ~+0.5 and only
// worker-ownership language reaches Socialist's +1.0. Only elites (Q12) is binary.
// Option order is load-bearing — the canonical keys in the resolver test index it.
export const CORE_QUESTIONS: readonly QuizQuestion[] = [
  // ---- ECON: market (-) vs collective (+), graduated left ----
  {
    id: 'econ-system',
    prompt: "The economy isn't working for regular people. What does it actually need?",
    options: [
      {
        label:
          'New ownership. The people who do the work should own and run the economy, not a boss class.',
        scores: { ECON: 2 },
      },
      {
        label: 'A fairer deal. Keep the market, but regulate it hard and make it serve everyone.',
        scores: { ECON: 0 },
      },
      {
        label: 'Room to grow. Free markets build the wealth; government mostly gets in the way.',
        scores: { ECON: -2 },
      },
    ],
  },
  {
    id: 'econ-healthcare',
    prompt: 'How should the country handle healthcare?',
    options: [
      {
        label: 'Make it fully public. Healthcare is a right, not a market.',
        scores: { ECON: 2 },
      },
      {
        label:
          'Add a public option. Expand coverage, but keep private plans for those who want them.',
        scores: { ECON: 1 },
      },
      {
        label:
          'Keep it private and competitive. Government control means worse care and longer waits.',
        scores: { ECON: -2 },
      },
    ],
  },
  {
    id: 'econ-wealth',
    prompt: 'The gap between the very richest and everyone else keeps widening. What about wealth?',
    options: [
      {
        label:
          'Tax wealth itself and break up fortunes that large. No one needs a billion dollars.',
        scores: { ECON: 2 },
      },
      {
        label: 'Raise taxes on top earners to fund programs, without going after wealth itself.',
        scores: { ECON: 1 },
      },
      {
        label:
          'Cut taxes and let people keep what they earn. They spend it better than government.',
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
          'Control and compassion. Strong borders, plus a fair path for those who build a life here.',
        scores: { NATION: 0 },
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
  // ---- ESTAB: anti-establishment (-) vs institutionalist (+). Primary dimension (§7.2).
  // experts has a committed trust-but-verify middle (+1, a landing spot for real
  // moderates, NOT a rescue for anti-establishment conservatives — those pick full
  // anti on both and still resolve Populist). elites is a concrete binary. ----
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
          'Trust, but verify. Start from the expertise, because it has earned that, but never on blind faith.',
        scores: { ESTAB: 1 },
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
    prompt: 'A senator gets rich trading stocks in the very industries their committee oversees.',
    options: [
      {
        label:
          "That's the system working as designed. It runs on legalized corruption, and no election changes that.",
        scores: { ESTAB: -2 },
      },
      {
        label:
          "Then enforce the law and vote them out. One crook isn't a rigged system, it's a job for the system.",
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

// Normalized tribe coordinates — RE-DERIVED (rev 3) as each tribe's honest
// issue-answer vector, the principled definition for an issue quiz (see §7.3).
// Graduated ECON (Fix A) + the illegitimacy-not-corruption Q12 (Fix B) moved
// several from the old hand-set values: notably Progressive is now ESTAB +1.0
// (institutionalist), STATE -0.33 (civil-libertarian on crime), NATION -1.0; and
// Liberal ECON +0.33 (a reachable mild-left, closing the coverage hole, Fix C).
export const TRIBE_TARGETS: readonly TribeTarget[] = [
  { slug: 'progressive', ECON: 0.67, SOCIAL: 1.0, ESTAB: 1.0, STATE: -0.33, NATION: -1.0 },
  { slug: 'socialist', ECON: 1.0, SOCIAL: 1.0, ESTAB: -1.0, STATE: -0.33, NATION: -1.0 },
  { slug: 'liberal', ECON: 0.33, SOCIAL: 0.67, ESTAB: 1.0, STATE: 0.0, NATION: -0.33 },
  { slug: 'conservative', ECON: -0.5, SOCIAL: -1.0, ESTAB: 0.75, STATE: 0.33, NATION: 0.67 },
  { slug: 'libertarian', ECON: -1.0, SOCIAL: 0.67, ESTAB: -1.0, STATE: -1.0, NATION: -0.33 },
  { slug: 'populist', ECON: 0.0, SOCIAL: -0.67, ESTAB: -1.0, STATE: 0.33, NATION: 1.0 },
  { slug: 'nationalist', ECON: 0.0, SOCIAL: -1.0, ESTAB: -1.0, STATE: 0.33, NATION: 1.0 },
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

export type TiebreakKey = 'prog-soc' | 'pop-nat' | 'con-pop' | 'prog-lib';

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
  'prog-lib': {
    pair: ['progressive', 'liberal'],
    questions: [
      {
        id: 'pl-pace',
        prompt: 'You both want the country to be fairer. How fast, and how deep?',
        options: [
          {
            label: 'Big and structural, and soon. Half-measures are how injustice survives.',
            vote: 'progressive',
          },
          {
            label: 'Step by step, within the system. Lasting change is built, not forced.',
            vote: 'liberal',
          },
        ],
      },
      {
        id: 'pl-institutions',
        prompt: 'And the institutions themselves?',
        options: [
          {
            label: 'Overhaul them. Too many were built to serve the powerful, and still do.',
            vote: 'progressive',
          },
          {
            label: 'Defend them and improve them. They are how a free society holds together.',
            vote: 'liberal',
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

interface Ranked {
  readonly slug: string;
  readonly d2: number;
}

/**
 * Rank comparator: nearest tribe first. EXACT d² ties are broken by ascending
 * slug — an explicit, TRIBE_TARGETS-order-independent rule, so reordering the
 * targets can never silently change a tie outcome. `p.d2 - q.d2` is 0 (falsy)
 * only on bit-exact equality, so the slug key fires only on a genuine tie.
 */
export function compareByDistance(p: Ranked, q: Ranked): number {
  return p.d2 - q.d2 || p.slug.localeCompare(q.slug);
}

/**
 * Resolve the 12 core answers (option indices, in CORE_QUESTIONS order) into a
 * placement decision. Missing/out-of-range answers are ignored. Returns `branch`
 * so the UI knows which runoff to run next; the 7-way resolution never re-runs.
 * Total: any input (empty, sparse, out-of-range, overlong) yields exactly one
 * valid tribe as `best`; it never returns null/undefined or throws.
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
  })).sort(compareByDistance);

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
