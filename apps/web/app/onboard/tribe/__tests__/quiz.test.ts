import { describe, expect, it } from 'vitest';

import {
  BORDER_MARGIN,
  CORE_QUESTIONS,
  QUIZ_INTRO,
  TIEBREAK_BANKS,
  TRIBE_TARGETS,
  type TiebreakKey,
  compareByDistance,
  resolveCore,
  resolveTiebreak,
} from '../quiz.js';

const VALID_SLUGS = new Set(TRIBE_TARGETS.map((t) => t.slug));

// Canonical self-placement — the §7 verification, rev 3 (graduated ECON + the
// illegitimacy-not-corruption Q12). Coordinates are re-derived as each tribe's
// honest issue-answer vector, so each self-places at d²=0. Five place directly;
// Populist/Nationalist (identical except SOCIAL) resolve through the PN bank.
//
// Answer order Q1–Q12: econ-system, healthcare, wealth (ECON) · abortion, lgbtq,
// religion (SOCIAL) · guns, crime (STATE) · immigration, foreign (NATION) ·
// experts, elites (ESTAB).
interface Canonical {
  readonly core: number[];
  readonly branch?: TiebreakKey;
  readonly bank?: number[];
}

const CANONICAL: Record<string, Canonical> = {
  progressive: { core: [1, 0, 0, 0, 0, 2, 2, 2, 2, 2, 2, 1] },
  socialist: { core: [0, 0, 0, 0, 0, 2, 2, 2, 2, 2, 0, 0] },
  liberal: { core: [1, 1, 1, 0, 0, 1, 1, 1, 1, 2, 2, 1] },
  conservative: { core: [2, 2, 1, 2, 2, 0, 0, 0, 0, 1, 1, 1] },
  libertarian: { core: [2, 2, 2, 0, 1, 2, 0, 2, 2, 0, 0, 0] },
  populist: { core: [1, 2, 0, 2, 1, 0, 0, 0, 0, 0, 0, 0], branch: 'pop-nat', bank: [0, 0] },
  nationalist: { core: [1, 2, 0, 2, 2, 0, 0, 0, 0, 0, 0, 0], branch: 'pop-nat', bank: [1, 1] },
};

describe('resolveCore + runoff — each tribe self-places (§7 verification)', () => {
  for (const [slug, c] of Object.entries(CANONICAL)) {
    it(`${slug} resolves to itself`, () => {
      const r = resolveCore(c.core);
      if (c.branch) {
        expect(r.confident).toBe(false);
        expect(r.branch).toBe(c.branch);
        expect(new Set([r.best, r.runnerUp])).toEqual(new Set(TIEBREAK_BANKS[c.branch].pair));
        expect(resolveTiebreak(c.branch, c.bank!, r.best)).toBe(slug);
      } else {
        expect(r.confident).toBe(true);
        expect(r.branch).toBeNull();
        expect(r.best).toBe(slug);
        expect(r.margin).toBeGreaterThanOrEqual(BORDER_MARGIN);
      }
    });
  }
});

// Regression locks — the calibration hole that shipped and got fixed. A mainstream
// Democrat must land Liberal (was Socialist); a mainstream Republican Conservative.
describe('mainstream-voter regression traces', () => {
  // Regulate the market, public option, raise top rates modestly, pro-choice,
  // pro-LGBTQ, secular, some gun limits, moderate crime/immigration,
  // internationalist, trust the process, enforce the law on the corrupt senator.
  const DEMOCRAT = [1, 1, 1, 0, 0, 2, 1, 1, 1, 2, 2, 1];
  // Free market, private care, cut taxes, pro-life, traditional, faith-in-public,
  // pro-gun, tough-on-crime, secure border, strength-with-judgment, trust-but-verify,
  // enforce the law.
  const REPUBLICAN = [2, 2, 2, 2, 2, 0, 0, 0, 0, 1, 1, 1];

  it('a mainstream Democrat lands Liberal, confidently (NOT Socialist)', () => {
    const r = resolveCore(DEMOCRAT);
    expect(r.best).toBe('liberal');
    expect(r.confident).toBe(true);
    expect(r.best).not.toBe('socialist');
  });

  it('a mainstream Republican lands Conservative, confidently', () => {
    const r = resolveCore(REPUBLICAN);
    expect(r.best).toBe('conservative');
    expect(r.confident).toBe(true);
  });
});

describe('runoff banks resolve both sides + tie fallback', () => {
  it('prog-soc', () => {
    expect(resolveTiebreak('prog-soc', [0, 0], 'progressive')).toBe('progressive');
    expect(resolveTiebreak('prog-soc', [1, 1], 'progressive')).toBe('socialist');
  });
  it('pop-nat', () => {
    expect(resolveTiebreak('pop-nat', [0, 0], 'populist')).toBe('populist');
    expect(resolveTiebreak('pop-nat', [1, 1], 'populist')).toBe('nationalist');
  });
  it('con-pop', () => {
    expect(resolveTiebreak('con-pop', [0, 0], 'populist')).toBe('conservative');
    expect(resolveTiebreak('con-pop', [1, 1], 'conservative')).toBe('populist');
  });
  it('prog-lib', () => {
    expect(resolveTiebreak('prog-lib', [0, 0], 'liberal')).toBe('progressive');
    expect(resolveTiebreak('prog-lib', [1, 1], 'progressive')).toBe('liberal');
  });
  it('a 1-1 split falls back to the core lean', () => {
    expect(resolveTiebreak('prog-lib', [0, 1], 'liberal')).toBe('liberal');
    expect(resolveTiebreak('prog-lib', [0, 1], 'progressive')).toBe('progressive');
  });
});

describe('structural invariants', () => {
  it('12 core questions, unique ids; only elites (Q12) is binary', () => {
    expect(CORE_QUESTIONS).toHaveLength(12);
    expect(new Set(CORE_QUESTIONS.map((q) => q.id)).size).toBe(12);
    expect(CORE_QUESTIONS[11]!.options).toHaveLength(2);
    for (let i = 0; i < 11; i++) expect(CORE_QUESTIONS[i]!.options).toHaveLength(3);
  });

  it('7 tribe targets, matching the canonical keys', () => {
    expect(TRIBE_TARGETS).toHaveLength(7);
    expect(new Set(TRIBE_TARGETS.map((t) => t.slug))).toEqual(new Set(Object.keys(CANONICAL)));
  });

  it('four banks; each 2 questions of 2 options voting for its pair', () => {
    const keys = Object.keys(TIEBREAK_BANKS) as TiebreakKey[];
    expect(keys).toHaveLength(4);
    for (const key of keys) {
      const bank = TIEBREAK_BANKS[key];
      const pair = new Set(bank.pair);
      expect(bank.questions).toHaveLength(2);
      for (const q of bank.questions) {
        expect(q.options).toHaveLength(2);
        for (const o of q.options) expect(pair.has(o.vote)).toBe(true);
      }
    }
  });

  it('every bank pair is distinct — nearest-two maps to at most one bank (no misroute)', () => {
    const keys = Object.keys(TIEBREAK_BANKS) as TiebreakKey[];
    const signatures = keys.map((k) => [...TIEBREAK_BANKS[k].pair].sort().join('|'));
    expect(new Set(signatures).size).toBe(keys.length);
  });

  it('every canonical core answer is one in-range index per question', () => {
    for (const { core } of Object.values(CANONICAL)) {
      expect(core).toHaveLength(CORE_QUESTIONS.length);
      core.forEach((idx, q) => {
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(CORE_QUESTIONS[q]!.options.length);
      });
    }
  });

  it('an empty answer set opens the override', () => {
    const r = resolveCore([]);
    expect(r.showOverride).toBe(true);
    expect(r.confident).toBe(false);
  });

  it('exposes the forced-choice intro line', () => {
    expect(QUIZ_INTRO).toMatch(/closest to your view/i);
  });
});

describe('exact-tie tie-break is explicit (ascending slug, not array order)', () => {
  it('equal d² orders by ascending slug', () => {
    expect(
      compareByDistance({ slug: 'socialist', d2: 1 }, { slug: 'liberal', d2: 1 }),
    ).toBeGreaterThan(0);
    expect(
      compareByDistance({ slug: 'liberal', d2: 1 }, { slug: 'socialist', d2: 1 }),
    ).toBeLessThan(0);
    expect(compareByDistance({ slug: 'liberal', d2: 1 }, { slug: 'liberal', d2: 1 })).toBe(0);
  });

  it('distance dominates when d² differ (nearer wins regardless of slug)', () => {
    expect(compareByDistance({ slug: 'aaa', d2: 0.5 }, { slug: 'zzz', d2: 0.6 })).toBeLessThan(0);
    expect(compareByDistance({ slug: 'zzz', d2: 0.5 }, { slug: 'aaa', d2: 0.6 })).toBeLessThan(0);
  });

  it('a tie sorts deterministically by slug, independent of input order', () => {
    const tied = [
      { slug: 'socialist', d2: 1 },
      { slug: 'liberal', d2: 1 },
      { slug: 'progressive', d2: 1 },
    ];
    const forward = [...tied].sort(compareByDistance).map((x) => x.slug);
    const reversed = [...tied]
      .reverse()
      .sort(compareByDistance)
      .map((x) => x.slug);
    expect(forward).toEqual(['liberal', 'progressive', 'socialist']);
    expect(reversed).toEqual(['liberal', 'progressive', 'socialist']);
  });
});

describe('totality — resolveCore always yields exactly one valid tribe, never throws', () => {
  const inputs: Array<{ name: string; answers: number[] }> = [
    { name: 'empty', answers: [] },
    { name: 'all midpoints', answers: Array(12).fill(1) },
    { name: 'out-of-range high', answers: Array(12).fill(9) },
    { name: 'negative indices', answers: Array(12).fill(-1) },
    { name: 'overlong', answers: Array(30).fill(1) },
    { name: 'too short', answers: [0, 1] },
    { name: 'mixed invalid', answers: [0, 99, -3, 2, 1, 0, 2, 1, 5, 0, 1, 0] },
  ];
  for (const { name, answers } of inputs) {
    it(`${name} → one valid tribe + exactly one downstream outcome`, () => {
      const r = resolveCore(answers);
      expect(VALID_SLUGS.has(r.best)).toBe(true);
      expect(VALID_SLUGS.has(r.runnerUp)).toBe(true);
      const active = [r.confident, r.branch !== null, r.showOverride].filter(Boolean).length;
      expect(active).toBe(1);
    });
  }

  it('sparse array (holes) is ignored and still resolves', () => {
    const sparse: number[] = [];
    sparse[0] = 0;
    sparse[11] = 1;
    expect(VALID_SLUGS.has(resolveCore(sparse).best)).toBe(true);
  });

  it('a 2000-case deterministic fuzz sweep never throws and always yields a valid best', () => {
    let seed = 0x2545f491;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    for (let i = 0; i < 2000; i++) {
      const len = next() % 16;
      const answers = Array.from({ length: len }, () => (next() % 8) - 2); // -2..5, incl out-of-range
      const r = resolveCore(answers);
      expect(VALID_SLUGS.has(r.best)).toBe(true);
      const active = [r.confident, r.branch !== null, r.showOverride].filter(Boolean).length;
      expect(active).toBe(1);
    }
  });
});

describe('totality — resolveTiebreak always returns a slug in the pair, never throws', () => {
  const banks = Object.keys(TIEBREAK_BANKS) as TiebreakKey[];
  for (const branch of banks) {
    const pair = new Set(TIEBREAK_BANKS[branch].pair);
    const [a] = TIEBREAK_BANKS[branch].pair;
    const cases: number[][] = [[], [9, 9], [-1, -1], [0, 1, 2, 3], [0]];
    for (const answers of cases) {
      it(`${branch} with ${JSON.stringify(answers)} → a slug in the pair`, () => {
        expect(pair.has(resolveTiebreak(branch, answers, a))).toBe(true);
      });
    }
    it(`${branch} with an out-of-pair coreBest on a 0-0 tie still returns a pair member`, () => {
      expect(pair.has(resolveTiebreak(branch, [], 'not-a-real-tribe'))).toBe(true);
    });
  }
});
