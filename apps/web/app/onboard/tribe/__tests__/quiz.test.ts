import { describe, expect, it } from 'vitest';

import { QUIZ_QUESTIONS, TRIBE_TARGETS, resolveTribe } from '../quiz.js';

// Option index convention: A = 0, B = 1, C = 2 (matches docs/TRIBE_QUIZ_PLAN.md).
// Each tribe's canonical answers (the §5 verification table, rev 4 — 13 questions)
// must resolve to that tribe, confidently. Keeping this table under CI is what
// keeps the scoring model honest against the doc: any question/score/target edit
// that breaks a canonical placement fails here.
//
// Answer order is Q1–Q13:
// Q1 fire-company(C) · Q2 guidance-reversal(T) · Q3 failing-school(C) ·
// Q4 hospital-suit(T) · Q5 employer-shutdown(S) · Q6 risky-tech(C) ·
// Q7 hospital-bill(S) · Q8 technicality(T) · Q9 rural-internet(S) ·
// Q10 public-support(S) · Q11 trusted-institution(T) · Q12 city-budget(C) ·
// Q13 tech-founder(T)
const CANONICAL: Record<string, number[]> = {
  // B C A C · A B B A B B · C C C
  libertarians: [1, 2, 0, 2, 0, 1, 1, 0, 1, 1, 2, 2, 2],
  // B B B C · B B A A A A · B A A
  progressives: [1, 1, 1, 2, 1, 1, 0, 0, 0, 0, 1, 0, 0],
  // C B C B · C C C C C C · B C A
  traditionalists: [2, 1, 2, 1, 2, 2, 2, 2, 2, 2, 1, 2, 0],
  // A A A A · C B C B C C · A B A
  populists: [0, 0, 0, 0, 2, 1, 2, 1, 2, 2, 0, 1, 0],
  // A A A C · A A B A C C · C A B
  accelerationists: [0, 0, 0, 2, 0, 0, 1, 0, 2, 2, 2, 0, 1],
};

describe('resolveTribe — canonical answers place each tribe correctly (§5)', () => {
  for (const [slug, answers] of Object.entries(CANONICAL)) {
    it(`${slug} resolves to itself with confident:true`, () => {
      const result = resolveTribe(answers);
      expect(result.slug).toBe(slug);
      expect(result.confident).toBe(true);
    });
  }
});

describe('resolveTribe — structural invariants', () => {
  it('the quiz is 13 questions, each with three options', () => {
    expect(QUIZ_QUESTIONS).toHaveLength(13);
    for (const q of QUIZ_QUESTIONS) {
      expect(q.options).toHaveLength(3);
    }
  });

  it('question ids are unique', () => {
    const ids = QUIZ_QUESTIONS.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every canonical answer set has one in-range index per question', () => {
    for (const answers of Object.values(CANONICAL)) {
      expect(answers).toHaveLength(QUIZ_QUESTIONS.length);
      answers.forEach((idx, q) => {
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(QUIZ_QUESTIONS[q]!.options.length);
      });
    }
  });

  it('every tribe target slug exists in the seed set (5 tribes)', () => {
    expect(TRIBE_TARGETS).toHaveLength(5);
    expect(new Set(TRIBE_TARGETS.map((t) => t.slug))).toEqual(new Set(Object.keys(CANONICAL)));
  });

  it('an empty answer set is low-confidence (opens the override)', () => {
    expect(resolveTribe([]).confident).toBe(false);
  });

  it('always returns a valid tribe slug for any answers', () => {
    const slugs = new Set(TRIBE_TARGETS.map((t) => t.slug));
    expect(slugs.has(resolveTribe(Array(13).fill(0)).slug)).toBe(true);
    expect(slugs.has(resolveTribe(Array(13).fill(2)).slug)).toBe(true);
    expect(slugs.has(resolveTribe([]).slug)).toBe(true);
  });
});
