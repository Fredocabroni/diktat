// Tribe-placement quiz — pure content + scoring. No React, no network, so the
// resolver is unit-testable in isolation. Design + verification table live in
// docs/TRIBE_QUIZ_PLAN.md (rev 5). Slugs must match the tribe seed (migration
// 20260420090008).
//
// Axes: C = change vs continuity, T = elite/institutional trust (both primary);
// S = state power (a half-weight tiebreaker). Options never name a tribe and the
// axis scores are hidden from the user — placement stays viewpoint-neutral
// (VISION §7).
//
// Rev 5: length + punctuation pass over rev 4's 13 questions. One-line scene per
// question, one-sentence options, house style (no em-dashes in user-facing copy).
// Scenes, scores, and axis assignments are unchanged from rev 4, so the §5
// canonical table and the resolver tests are unaffected.

export type Axis = 'S' | 'C' | 'T';
export type AxisScores = Partial<Record<Axis, number>>;

export interface QuizOption {
  readonly label: string;
  readonly scores: AxisScores;
}

export interface QuizQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly options: readonly QuizOption[];
}

// Option order is A, B, C (indices 0, 1, 2) and MUST match the §3 tables in
// docs/TRIBE_QUIZ_PLAN.md — the §5 canonical answer keys (and their CI test)
// address options by that index.
export const QUIZ_QUESTIONS: readonly QuizQuestion[] = [
  {
    id: 'fire-company',
    prompt:
      "Your town's volunteer fire company runs on trust and handshakes. The state says certify or shut down.",
    options: [
      {
        label: "Certify it. 'We've always done it this way' never put out a fire.",
        scores: { C: 2 },
      },
      {
        label: 'Keep the company, add the standards that save lives.',
        scores: { C: 0 },
      },
      {
        label: 'Hands off. Kill the trust that runs it and nobody answers the call.',
        scores: { C: -2 },
      },
    ],
  },
  {
    id: 'guidance-reversal',
    prompt:
      'The agencies reversed a decade of official guidance overnight, with all the certainty they had before.',
    options: [
      {
        label: "That's a guild protecting its authority, not the evidence talking.",
        scores: { T: -2 },
      },
      {
        label: "That's the process working. They moved when the data moved.",
        scores: { T: 2 },
      },
      {
        label: 'Take the finding. Skip the orders about what to do with it.',
        scores: { T: -1 },
      },
    ],
  },
  {
    id: 'failing-school',
    prompt:
      "Your town's hundred-year-old high school graduates a third of its seniors barely able to read.",
    options: [
      {
        label: "Replace it. A century of tradition doesn't buy one more failing class.",
        scores: { C: 2 },
      },
      {
        label: 'Overhaul it. New leadership, hard accountability, same school.',
        scores: { C: 1 },
      },
      {
        label: "The school isn't the disease. Rebuild what collapsed around it.",
        scores: { C: -2 },
      },
    ],
  },
  {
    id: 'hospital-suit',
    prompt:
      'A family sues the hospital three towns depend on. Botched surgery, or every protocol followed. Nobody knows.',
    options: [
      {
        label: 'The family. Institutions bury their mistakes for a living.',
        scores: { T: -2 },
      },
      {
        label: "The hospital. One family's grief isn't evidence.",
        scores: { T: 2 },
      },
      {
        label: 'The hospital, if it opens every record to be checked.',
        scores: { T: 1 },
      },
    ],
  },
  {
    id: 'employer-shutdown',
    prompt: "The town's biggest employer shuts down overnight. Hundreds lose their paycheck.",
    options: [
      {
        label: 'Cut the taxes and red tape so new employers move in.',
        scores: { S: -2 },
      },
      {
        label: 'Put a floor under them. Retraining, benefits, direct support.',
        scores: { S: 2 },
      },
      {
        label: 'Rally the town. Local business and neighbors before any agency.',
        scores: { S: 0 },
      },
    ],
  },
  {
    id: 'risky-tech',
    prompt: 'A new technology could save thousands of lives and carries risks nobody can map.',
    options: [
      {
        label: 'Ship it. Delay has a body count too.',
        scores: { C: 2 },
      },
      {
        label: 'Move, but lock in the guardrails before it scales.',
        scores: { C: 0 },
      },
      {
        label: "Slow down. Some doors don't close once they open.",
        scores: { C: -2 },
      },
    ],
  },
  {
    id: 'hospital-bill',
    prompt: "A working family can't cover a hospital bill that would wipe out a year's savings.",
    options: [
      {
        label: 'Guarantee it. Some needs are too basic to price.',
        scores: { S: 2 },
      },
      {
        label: 'Open the market so care costs what it should, not what the cartel charges.',
        scores: { S: -2 },
      },
      {
        label: 'Mutual aid. Community funds, people covering their own.',
        scores: { S: 0 },
      },
    ],
  },
  {
    id: 'technicality',
    prompt: 'A guilty man walks free. Police skipped a warrant, so the evidence is thrown out.',
    options: [
      {
        label: "Good. Trust the rule precisely because you can't trust the people enforcing it.",
        scores: { T: -1 },
      },
      {
        label: 'A guilty man walks and the victim eats it. The rules shield insiders.',
        scores: { T: -2 },
      },
      {
        label: 'The law has to hold even when it stings.',
        scores: { T: 2 },
      },
    ],
  },
  {
    id: 'rural-internet',
    prompt: 'No company will wire the rural county. Kids do their homework in parking lots.',
    options: [
      {
        label: 'Public build. The market already looked and walked away.',
        scores: { S: 2 },
      },
      {
        label: 'Clear the permits and let a company find the profit.',
        scores: { S: -2 },
      },
      {
        label: 'Let the towns wire themselves. Co-ops, neighbors pooling in.',
        scores: { S: 0 },
      },
    ],
  },
  {
    id: 'public-support',
    prompt:
      "Your neighbor's been on public support three years. Lifeline, or a trap that pays him to stay stuck.",
    options: [
      {
        label: 'Fund it. Letting people drown to motivate them is just cruelty.',
        scores: { S: 2 },
      },
      {
        label: 'Shrink it to a floor. Help you lean on forever becomes a cage.',
        scores: { S: -2 },
      },
      {
        label: 'Tie it to the community. Work he can do, people who know him.',
        scores: { S: 0 },
      },
    ],
  },
  {
    id: 'trusted-institution',
    prompt:
      'The one institution you always defended did something indefensible and buried it. It comes out.',
    options: [
      {
        label: 'Done. If even that one hid its rot, they all run on PR.',
        scores: { T: -2 },
      },
      {
        label: "One betrayal doesn't erase what it earned. Hold it to account, don't torch it.",
        scores: { T: 2 },
      },
      {
        label: 'Proof nothing gets a permanent pass. Audit it harder now.',
        scores: { T: -1 },
      },
    ],
  },
  {
    id: 'city-budget',
    prompt:
      "Your city can bet its whole budget on leveling downtown and building new, or keep patching what's there.",
    options: [
      {
        label: 'Swing big. Cities that only patch decay in slow motion.',
        scores: { C: 2 },
      },
      {
        label: 'One bold project it can afford to lose, not the whole treasury.',
        scores: { C: 0 },
      },
      {
        label: "Patch and maintain. Don't stake the city on an untested blueprint.",
        scores: { C: -2 },
      },
    ],
  },
  {
    id: 'tech-founder',
    prompt: 'A founder nobody elected controls the tools half the country runs on. And it works.',
    options: [
      {
        label: 'A king is a king, whether the crown is a server farm.',
        scores: { T: -2 },
      },
      {
        label: 'Good. Whoever builds the future has earned the right to run it.',
        scores: { T: 1 },
      },
      {
        label: "Fine, until you can't switch off his tools without switching off your life.",
        scores: { T: -1 },
      },
    ],
  },
];

export interface TribeTarget {
  readonly slug: string;
  readonly S: number;
  readonly C: number;
  readonly T: number;
}

/** Normalized tribe coordinates (raw ÷ 2). Slugs match the seed. */
export const TRIBE_TARGETS: readonly TribeTarget[] = [
  { slug: 'libertarians', S: -1, C: 0, T: -0.5 },
  { slug: 'progressives', S: 1, C: 0.5, T: 0.5 },
  { slug: 'traditionalists', S: 0, C: -1, T: 1 },
  { slug: 'populists', S: 0, C: 0.5, T: -1 },
  { slug: 'accelerationists', S: -0.5, C: 1, T: -0.5 },
];

// Max achievable |sum| per axis (normalization divisors = question count × 2)
// and axis weights. 4 Change / 5 Trust / 4 State questions.
const DIVISOR: Record<Axis, number> = { S: 8, C: 8, T: 10 };
const WEIGHT: Record<Axis, number> = { S: 0.5, C: 1, T: 1 };

// Below this margin between the top two tribes, or this user-vector magnitude,
// the result is low-confidence and the UI opens on the all-five override.
const CONFIDENT_MARGIN = 0.15;
const CONFIDENT_MAGNITUDE = 0.35;

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

export interface QuizResult {
  /** Nearest tribe's slug. */
  readonly slug: string;
  /** False when the result is ambiguous — the UI should lead with the override. */
  readonly confident: boolean;
}

/**
 * Resolve a list of chosen option indices (one per question, in QUIZ_QUESTIONS
 * order) to the nearest tribe. Missing/out-of-range answers are ignored.
 */
export function resolveTribe(answers: readonly number[]): QuizResult {
  const raw: Record<Axis, number> = { S: 0, C: 0, T: 0 };
  answers.forEach((optionIndex, questionIndex) => {
    const option = QUIZ_QUESTIONS[questionIndex]?.options[optionIndex];
    if (!option) return;
    (['S', 'C', 'T'] as const).forEach((axis) => {
      raw[axis] += option.scores[axis] ?? 0;
    });
  });

  const v: Record<Axis, number> = {
    S: clamp(raw.S / DIVISOR.S, -1, 1),
    C: clamp(raw.C / DIVISOR.C, -1, 1),
    T: clamp(raw.T / DIVISOR.T, -1, 1),
  };

  const ranked = TRIBE_TARGETS.map((t) => ({
    slug: t.slug,
    d2: WEIGHT.S * (v.S - t.S) ** 2 + WEIGHT.C * (v.C - t.C) ** 2 + WEIGHT.T * (v.T - t.T) ** 2,
    sDist: Math.abs(v.S - t.S),
  })).sort((a, b) => a.d2 - b.d2 || a.sDist - b.sDist);

  const best = ranked[0]!;
  const second = ranked[1]!;
  const magnitude = Math.hypot(v.S, v.C, v.T);
  const confident = second.d2 - best.d2 >= CONFIDENT_MARGIN && magnitude >= CONFIDENT_MAGNITUDE;

  return { slug: best.slug, confident };
}
