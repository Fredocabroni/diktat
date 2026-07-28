import { describe, expect, it } from 'vitest';

import {
  BORDER_MARGIN,
  CORE_QUESTIONS,
  TIEBREAK_BANKS,
  TRIBE_TARGETS,
  resolveCore,
  resolveTiebreak,
} from '../quiz.js';

// Canonical self-placement — the verification table in docs/TRIBE_OVERHAUL_PLAN.md.
// Each tribe answers every core question at its own pole; the resulting vector
// MUST resolve to that tribe, confidently (margin >= BORDER_MARGIN, no branch, no
// override). Keeping this under CI is what keeps the 5-axis model honest against
// the doc: any question/score/target edit that breaks a canonical placement fails
// here.
//
// Answer order is Q1–Q13:
// ECON: factory-sale, wealth-gap, new-industry · SOCIAL: new-generation, monument,
// old-custom · ESTAB: experts, insider-rule, institution-failure ·
// STATE: surveillance, mandate · NATION: supranational, spend-home
const CANONICAL: Record<string, number[]> = {
  progressive: [1, 0, 0, 0, 0, 0, 2, 1, 1, 2, 2, 2, 1],
  socialist: [0, 0, 0, 0, 0, 1, 0, 1, 1, 2, 2, 2, 1],
  liberal: [1, 1, 1, 0, 1, 1, 2, 2, 2, 1, 1, 2, 1],
  conservative: [2, 1, 2, 2, 2, 2, 1, 2, 1, 1, 1, 0, 1],
  libertarian: [2, 2, 2, 0, 0, 1, 0, 1, 1, 0, 0, 2, 1],
  populist: [1, 0, 2, 1, 1, 2, 0, 0, 0, 1, 1, 0, 1],
  nationalist: [1, 1, 1, 2, 2, 2, 0, 1, 1, 2, 2, 0, 0],
};

describe('resolveCore — canonical answers place each tribe (verification table)', () => {
  for (const [slug, answers] of Object.entries(CANONICAL)) {
    it(`${slug} resolves to itself, confidently, with no branch/override`, () => {
      const r = resolveCore(answers);
      expect(r.best).toBe(slug);
      expect(r.confident).toBe(true);
      expect(r.branch).toBeNull();
      expect(r.showOverride).toBe(false);
      expect(r.margin).toBeGreaterThanOrEqual(BORDER_MARGIN);
    });
  }
});

describe('resolveCore — structural invariants', () => {
  it('the core quiz is 13 questions, each with three options', () => {
    expect(CORE_QUESTIONS).toHaveLength(13);
    for (const q of CORE_QUESTIONS) expect(q.options).toHaveLength(3);
  });

  it('question ids are unique', () => {
    const ids = CORE_QUESTIONS.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('there are exactly 7 tribe targets, matching the canonical keys', () => {
    expect(TRIBE_TARGETS).toHaveLength(7);
    expect(new Set(TRIBE_TARGETS.map((t) => t.slug))).toEqual(new Set(Object.keys(CANONICAL)));
  });

  it('every canonical answer set has one in-range index per question', () => {
    for (const answers of Object.values(CANONICAL)) {
      expect(answers).toHaveLength(CORE_QUESTIONS.length);
      answers.forEach((idx, q) => {
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(CORE_QUESTIONS[q]!.options.length);
      });
    }
  });

  it('near-neutral answers open the override, not a confident placement', () => {
    const allMid = CORE_QUESTIONS.map(() => 1); // every midpoint
    const r = resolveCore(allMid);
    expect(r.confident).toBe(false);
    expect(r.showOverride).toBe(true);
    expect(r.branch).toBeNull();
  });

  it('an empty answer set opens the override', () => {
    const r = resolveCore([]);
    expect(r.confident).toBe(false);
    expect(r.showOverride).toBe(true);
  });

  it('always names a valid tribe as best for any answers', () => {
    const slugs = new Set(TRIBE_TARGETS.map((t) => t.slug));
    expect(slugs.has(resolveCore(Array(13).fill(0)).best)).toBe(true);
    expect(slugs.has(resolveCore(Array(13).fill(2)).best)).toBe(true);
    expect(slugs.has(resolveCore([]).best)).toBe(true);
  });
});

describe('adaptive tie-breaker — fires once, resolves the pair, terminal', () => {
  // A vector deliberately parked between Progressive and Liberal: ECON +0.33,
  // SOCIAL +0.67, STATE +0.25, ESTAB +0.67, NATION -0.5.
  const progLibBorder = [1, 0, 1, 0, 0, 1, 2, 2, 1, 2, 1, 2, 1];

  it('a Prog/Lib border vector triggers the prog-lib bank (not a confident place)', () => {
    const r = resolveCore(progLibBorder);
    expect(r.confident).toBe(false);
    expect(r.showOverride).toBe(false);
    expect(r.branch).toBe('prog-lib');
    expect(new Set([r.best, r.runnerUp])).toEqual(new Set(['progressive', 'liberal']));
    expect(r.margin).toBeLessThan(BORDER_MARGIN);
  });

  it('the prog-lib bank votes place the user (all-progressive answers)', () => {
    const { best } = resolveCore(progLibBorder);
    // Option idx0 in every prog-lib question votes progressive.
    expect(resolveTiebreak('prog-lib', [0, 0, 0], best)).toBe('progressive');
    // Option idx1 votes liberal.
    expect(resolveTiebreak('prog-lib', [1, 1, 1], best)).toBe('liberal');
    // Mixed 2–1 for liberal.
    expect(resolveTiebreak('prog-lib', [0, 1, 1], best)).toBe('liberal');
  });

  it('a pop-nat two-question tie falls back to the core lean', () => {
    // B1 idx0 = populist, B2 idx0 = nationalist -> 1–1 tie.
    expect(resolveTiebreak('pop-nat', [0, 0], 'nationalist')).toBe('nationalist');
    expect(resolveTiebreak('pop-nat', [0, 0], 'populist')).toBe('populist');
    // Non-tie ignores the core lean.
    expect(resolveTiebreak('pop-nat', [0, 1], 'nationalist')).toBe('populist');
  });

  it('every tie-breaker option votes for one of its bank pair', () => {
    for (const key of Object.keys(TIEBREAK_BANKS) as Array<keyof typeof TIEBREAK_BANKS>) {
      const bank = TIEBREAK_BANKS[key];
      const pair = new Set(bank.pair);
      for (const q of bank.questions) {
        expect(q.options).toHaveLength(2);
        for (const o of q.options) expect(pair.has(o.vote)).toBe(true);
      }
    }
  });
});
