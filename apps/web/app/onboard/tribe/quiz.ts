// Tribe-placement quiz — pure content + scoring. No React, no network, so the
// resolver is unit-testable in isolation. Design + verification table live in
// docs/TRIBE_QUIZ_PLAN.md (rev 4). Slugs must match the tribe seed (migration
// 20260420090008).
//
// Axes: C = change vs continuity, T = elite/institutional trust (both primary);
// S = state power (a half-weight tiebreaker). Options never name a tribe and the
// axis scores are hidden from the user — placement stays viewpoint-neutral
// (VISION §7).
//
// Rev 4: 13 scene-driven questions — 4 Change / 5 Trust / 4 State. The 5th Trust
// question (tech-founder) sharpens the Populist↔Accelerationist boundary; that
// pair's 0.625 margin is the geometric maximum, not a tuning target (see §5).

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
      "For as long as anyone remembers, your town's fire company has run on volunteers and handshakes — no certifications, no county oversight, neighbors saving neighbors. After one bad night, the state says professionalize: certified crews and real rules, or get shut down.",
    options: [
      {
        label:
          "Modernize it. “We've always done it this way” is not a fire plan — bring in the standards, even if the old guard walks.",
        scores: { C: 2 },
      },
      {
        label:
          "Add the standards that save lives, keep the company that's always shown up. Reform it, don't replace it.",
        scores: { C: 0 },
      },
      {
        label:
          "Keep it in the town's hands. Strip out what made it work — the trust, the belonging — and you'll have a compliant service nobody answers the call for.",
        scores: { C: -2 },
      },
    ],
  },
  {
    id: 'guidance-reversal',
    prompt:
      'For a decade the official guidance said one thing, and millions built their lives around it. This week the same agencies reversed it — the old advice was shaky — and they’re backing the new rule with the exact certainty they had for the old one.',
    options: [
      {
        label:
          "That's the tell. When the same credentialed voices are this certain both times, you're watching a guild defend its authority, not follow the evidence.",
        scores: { T: -2 },
      },
      {
        label:
          'That’s the process working — they moved when the data moved. Punish them for correcting course and you teach institutions to never admit they were wrong.',
        scores: { T: 2 },
      },
      {
        label:
          'Take the finding, skip the sermon. Trust what they measured; don’t let them dictate what you do about it.',
        scores: { T: -1 },
      },
    ],
  },
  {
    id: 'failing-school',
    prompt:
      'The public high school that’s anchored your town for a hundred years now graduates a third of its seniors reading at a sixth-grade level. Same building, same district, worse every year. What does it need:',
    options: [
      {
        label:
          "Replace it. Open the doors to new schools, new operators, new models — a century of tradition doesn't earn it one more failing class.",
        scores: { C: 2 },
      },
      {
        label:
          'Overhaul it — new leadership, new curriculum, hard accountability — but keep the school the town built.',
        scores: { C: 1 },
      },
      {
        label:
          "The school isn't the disease. Rebuild what collapsed around it — gut the institution and you tear out the neighborhood's last anchor with it.",
        scores: { C: -2 },
      },
    ],
  },
  {
    id: 'hospital-suit',
    prompt:
      'A family in your county is suing the hospital that three towns depend on — they say it botched a surgery and closed ranks. The hospital says the records show every protocol followed. The town is the jury pool, and honestly nobody knows.',
    options: [
      {
        label:
          'The family. The hospital has the lawyers, the records, and the reputation — the deck is stacked before anyone sits down. Institutions bury their mistakes for a living.',
        scores: { T: -2 },
      },
      {
        label:
          "The hospital. It carries the protocols and the expertise that keep the rest of us alive — one grieving family's certainty isn't evidence.",
        scores: { T: 2 },
      },
      {
        label:
          'The hospital — but open every record and let it be checked in daylight. Its word is worth exactly what it will let you verify.',
        scores: { T: 1 },
      },
    ],
  },
  {
    id: 'employer-shutdown',
    prompt:
      'The town’s biggest employer shuts down overnight — hundreds lose their paycheck at once. The response you’d get behind:',
    options: [
      {
        label:
          'Clear the runway for what’s next — cut the taxes and red tape so new employers move in and hire.',
        scores: { S: -2 },
      },
      {
        label:
          'Put a real floor under them — retraining, benefits, direct support — so no family free-falls in the gap.',
        scores: { S: 2 },
      },
      {
        label:
          'Rally the town itself — local business, churches, neighbors — before any distant agency shows up.',
        scores: { S: 0 },
      },
    ],
  },
  {
    id: 'risky-tech',
    prompt:
      'A new technology could save a lot of lives — and carries risks nobody can fully map yet. The right pace:',
    options: [
      {
        label:
          'Ship it. People are dying on the waitlist while we hold hearings — delay has a body count too.',
        scores: { C: 2 },
      },
      {
        label: 'Move, but with guardrails — limits and oversight locked in before it scales.',
        scores: { C: 0 },
      },
      {
        label: 'Pump the brakes. Some doors don’t close once they’re open.',
        scores: { C: -2 },
      },
    ],
  },
  {
    id: 'hospital-bill',
    prompt:
      'A working family two towns over can’t cover a hospital bill that would wipe out a year’s savings. The fix that sits right with you:',
    options: [
      {
        label:
          'Guarantee it collectively — some needs are too basic to leave to whether you can pay.',
        scores: { S: 2 },
      },
      {
        label:
          'Open the market — real prices, real competition — so care costs what it should instead of whatever the cartel charges.',
        scores: { S: -2 },
      },
      {
        label:
          'Neither bureaucracy nor billing department — mutual aid, community funds, people covering their own.',
        scores: { S: 0 },
      },
    ],
  },
  {
    id: 'technicality',
    prompt:
      'A man everyone knows is guilty walks free — police skipped a warrant, the evidence is thrown out. The system worked exactly as written.',
    options: [
      {
        label:
          "The rules held, and that's the point — you trust the process precisely because you can't trust the people running it. Better a guilty man free than officials who decide the rules don't apply to them.",
        scores: { T: -1 },
      },
      {
        label:
          "A guilty man walks and the victim gets nothing. The rules aren't sacred — they're the fine print insiders hide behind while ordinary people eat the loss.",
        scores: { T: -2 },
      },
      {
        label:
          "The law has to hold even when it stings. An institution that bends its own rules for the mob's outrage is worth less than one that frees a guilty man on principle.",
        scores: { T: 2 },
      },
    ],
  },
  {
    id: 'rural-internet',
    prompt:
      'A rural stretch of your region has no fast internet — too unprofitable to wire. Kids do homework in parking lots. The move:',
    options: [
      {
        label:
          'Public build — some infrastructure only exists because we decide together to lay it; the market already said no.',
        scores: { S: 2 },
      },
      {
        label:
          'Change the math for builders — clear the permits, hand over the spectrum, let a company find the profit and run it.',
        scores: { S: -2 },
      },
      {
        label:
          'Let the towns wire themselves — local co-ops, neighbors pooling to string their own line.',
        scores: { S: 0 },
      },
    ],
  },
  {
    id: 'public-support',
    prompt:
      'A neighbor’s been on public support three years. Half the town calls it a lifeline; half calls it a trap that pays people to stay stuck. Your read on the program:',
    options: [
      {
        label:
          "Fund it without flinching — letting people drown to 'motivate' them is cruelty with a spreadsheet.",
        scores: { S: 2 },
      },
      {
        label:
          "Shrink it to a floor — help that's easy to lean on forever stops being help and becomes a cage.",
        scores: { S: -2 },
      },
      {
        label:
          'Tie it to the community — work he can do, people who know his name — not a check and not a cutoff.',
        scores: { S: 0 },
      },
    ],
  },
  {
    id: 'trusted-institution',
    prompt:
      'The one institution you’ve always defended — your proof the system can work — quietly did something indefensible and buried it. It comes out. Where do you land:',
    options: [
      {
        label:
          "It's done. If even that one covered its own rot, the whole class of them runs on nerve and PR, not trust.",
        scores: { T: -2 },
      },
      {
        label:
          "One betrayal doesn't erase what it earned. Hold this to account, but don't torch an institution that's been right far more than wrong.",
        scores: { T: 2 },
      },
      {
        label:
          'Exactly why nothing gets a permanent pass — trust it only as far as it’s audited, and audit it harder now.',
        scores: { T: -1 },
      },
    ],
  },
  {
    id: 'city-budget',
    prompt:
      'Your city can bet its budget on one big swing — level the aging downtown and rebuild it from scratch as something new — or keep patching what’s there, block by block, year by year. The council asks where you land:',
    options: [
      {
        label:
          'Swing big. A city that only ever patches just decays in slow motion — bet the budget and build something worth inheriting.',
        scores: { C: 2 },
      },
      {
        label:
          'One bold project the city can afford to lose, the rest kept in repair. Gamble a corner, not the whole treasury.',
        scores: { C: 0 },
      },
      {
        label:
          "Patch and maintain. You don't stake a city's one budget on a blueprint nobody's ever built.",
        scores: { C: -2 },
      },
    ],
  },
  {
    id: 'tech-founder',
    prompt:
      'A founder almost nobody voted for now controls the tools half the country runs on — how they talk, pay, and get their news. He says he’s dragging the future forward faster than any government ever could. He’s not wrong that it works.',
    options: [
      {
        label:
          "That's the oldest story there is, in a hoodie. Unelected power over millions is unelected power — a king is a king whether the crown is a server farm.",
        scores: { T: -2 },
      },
      {
        label:
          'Good. Someone finally building instead of holding hearings — I’ll take the person shipping the future over the committee that would still be studying it in 2040.',
        scores: { T: 1 },
      },
      {
        label:
          "Power's fine as long as you can walk away. The moment you can't switch off his tools without switching off your life, it's not a product — it's a sovereign.",
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
// and axis weights. Rev 4: 4 Change / 5 Trust / 4 State questions.
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
