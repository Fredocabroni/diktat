// Tribe-placement quiz — pure content + scoring. No React, no network, so the
// resolver is unit-testable in isolation. Design + verification table live in
// docs/TRIBE_QUIZ_PLAN.md. Slugs must match the tribe seed (migration
// 20260420090008).
//
// Axes: C = change vs continuity, T = elite/institutional trust (both primary);
// S = state power (a half-weight tiebreaker). Options never name a tribe and the
// axis scores are hidden from the user — placement stays viewpoint-neutral
// (VISION §7).

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

export const QUIZ_QUESTIONS: readonly QuizQuestion[] = [
  {
    id: 'tradition',
    prompt:
      'A long-standing rule or tradition is under fire — plenty of people say it no longer fits how we live now. Your honest reaction:',
    options: [
      {
        label:
          "If it has outlived its purpose, replace it. Keeping something out of habit isn't a reason to keep it.",
        scores: { C: 2 },
      },
      {
        label: "Change the parts that are clearly failing, but don't tear out what still works.",
        scores: { C: 0 },
      },
      {
        label:
          "Be careful — things that have lasted this long usually solve problems we've stopped noticing.",
        scores: { C: -2 },
      },
    ],
  },
  {
    id: 'consensus',
    prompt:
      'On a contested issue, the experts, officials, and major institutions have mostly lined up on one side. That makes you:',
    options: [
      {
        label:
          "Wary. When the credentialed all agree, it's usually because the system rewards agreement, not truth.",
        scores: { T: -2 },
      },
      {
        label:
          "More confident. They can be wrong, but broad agreement among people who've studied it beats a hunch.",
        scores: { T: 2 },
      },
      {
        label:
          "Trust the measurements, not the marching orders — believe them on the facts, but experts don't get to decide what we do about them.",
        scores: { T: -1 },
      },
    ],
  },
  {
    id: 'breakthrough',
    prompt:
      'A breakthrough could do enormous good, but its risks are real and hard to foresee. The right pace is:',
    options: [
      {
        label:
          'Move now. Get it into the world and solve problems as they arise — waiting has a body count too.',
        scores: { C: 2 },
      },
      {
        label: 'Move deliberately — put limits and oversight in place before it scales.',
        scores: { C: 1 },
      },
      {
        label: 'Hold back. Some doors are very hard to close once they’re open.',
        scores: { C: -2 },
      },
    ],
  },
  {
    id: 'standoff',
    prompt:
      "Ordinary people are in a standoff with a powerful, established institution, and it's honestly unclear who's right. You find yourself pulling for:",
    options: [
      {
        label:
          'The people. The institution already has the resources and the benefit of the doubt — usually more than it has earned.',
        scores: { T: -2 },
      },
      {
        label:
          'The institution. It carries rules and hard-won knowledge that protect everyone, not just the loudest voice in the room.',
        scores: { T: 2 },
      },
      {
        label:
          'The institution — but hold it to its own rules. Its authority is only as good as its willingness to be checked.',
        scores: { T: 1 },
      },
    ],
  },
  {
    id: 'factory',
    prompt:
      'A major employer in a mid-size town shuts down, and hundreds lose their income at once. The response you’d get behind:',
    options: [
      {
        label:
          'Clear the way for what’s next — cut the red tape and taxes so new businesses can move in and hire.',
        scores: { S: -2 },
      },
      {
        label:
          'Put a real safety net under them — retraining, benefits, direct support — so no family free-falls during the transition.',
        scores: { S: 2, T: 1 },
      },
      {
        label:
          'Rally the town itself — local employers, community groups, neighbors stepping up before any distant agency does.',
        scores: { S: 0 },
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

// Max achievable |sum| per axis (normalization divisors) and axis weights.
const DIVISOR: Record<Axis, number> = { S: 2, C: 4, T: 5 };
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
