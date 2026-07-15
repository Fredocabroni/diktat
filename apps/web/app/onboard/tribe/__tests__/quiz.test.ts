import { describe, expect, it } from 'vitest';

import { QUIZ_QUESTIONS, TRIBE_TARGETS, resolveTribe } from '../quiz.js';

// Option index convention: A = 0, B = 1, C = 2 (matches docs/TRIBE_QUIZ_PLAN.md).
// Each tribe's canonical answers must resolve to that tribe (the §5 table).
const CANONICAL: Record<string, number[]> = {
  libertarians: [1, 2, 1, 2, 0], // B, C, B, C, A
  progressives: [1, 1, 1, 2, 1], // B, B, B, C, B
  traditionalists: [2, 1, 2, 1, 2], // C, B, C, B, C
  populists: [1, 0, 1, 0, 2], // B, A, B, A, C
  accelerationists: [0, 2, 0, 2, 0], // A, C, A, C, A
};

describe('resolveTribe — canonical answers place each tribe correctly', () => {
  for (const [slug, answers] of Object.entries(CANONICAL)) {
    it(`${slug} resolves to itself`, () => {
      const result = resolveTribe(answers);
      expect(result.slug).toBe(slug);
      expect(result.confident).toBe(true);
    });
  }
});

describe('resolveTribe — structural invariants', () => {
  it('every canonical answer set has one index per question', () => {
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
    expect(slugs.has(resolveTribe([0, 0, 0, 0, 0]).slug)).toBe(true);
    expect(slugs.has(resolveTribe([2, 2, 2, 2, 2]).slug)).toBe(true);
  });
});
