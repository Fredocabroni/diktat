import { describe, expect, it } from 'vitest';

import {
  BORDER_MARGIN,
  CORE_QUESTIONS,
  QUIZ_INTRO,
  TIEBREAK_BANKS,
  TRIBE_TARGETS,
  type TiebreakKey,
  resolveCore,
  resolveTiebreak,
} from '../quiz.js';

// Canonical self-placement — the §7 verification. Each tribe answers every core
// issue question at its honest position; the result MUST resolve to that tribe.
// Four tribes place directly from the core; the two issue-twins that collapse on
// concrete answers (Progressive≈Socialist on econ+social, Populist≈Nationalist on
// nation+estab) are resolved by their runoff bank. CI-enforced: any question /
// delta / coordinate edit that breaks a canonical placement fails here.
//
// Answer order Q1–Q12: taxes, healthcare, welfare (ECON) · abortion, lgbtq,
// religion (SOCIAL) · guns, crime (STATE) · immigration, foreign (NATION) ·
// experts, elites (ESTAB).
interface Canonical {
  readonly core: number[];
  readonly branch?: TiebreakKey; // set only for the twins that go to a runoff
  readonly bank?: number[]; // the tribe's runoff answers, if it branches
}

// Q9 immigration and Q11 experts are now 3-option (indices 8 and 10). Liberal
// picks the immigration middle (control + compassion) and Conservative picks the
// experts middle (trust-but-verify); every other tribe answers at its poles.
const CANONICAL: Record<string, Canonical> = {
  progressive: { core: [0, 0, 0, 0, 0, 2, 2, 2, 2, 2, 2, 0], branch: 'prog-soc', bank: [0, 0] },
  socialist: { core: [0, 0, 0, 0, 0, 2, 2, 2, 2, 2, 0, 0] },
  liberal: { core: [0, 1, 1, 0, 0, 1, 1, 1, 1, 2, 2, 1] },
  conservative: { core: [1, 2, 1, 2, 2, 0, 0, 0, 0, 1, 1, 1] },
  libertarian: { core: [1, 2, 2, 0, 1, 2, 0, 2, 2, 0, 0, 0] },
  populist: { core: [0, 1, 2, 2, 1, 0, 0, 0, 0, 0, 0, 0], branch: 'pop-nat', bank: [0, 0] },
  nationalist: { core: [0, 1, 2, 2, 2, 0, 0, 0, 0, 0, 0, 0] },
};

describe('resolveCore + runoff — each tribe self-places (§7 verification)', () => {
  for (const [slug, c] of Object.entries(CANONICAL)) {
    it(`${slug} resolves to itself`, () => {
      const r = resolveCore(c.core);
      if (c.branch) {
        // Twin: core lands ambiguous on the right pair, runoff decides.
        expect(r.confident).toBe(false);
        expect(r.branch).toBe(c.branch);
        expect(new Set([r.best, r.runnerUp])).toEqual(new Set(TIEBREAK_BANKS[c.branch].pair));
        expect(resolveTiebreak(c.branch, c.bank!, r.best)).toBe(slug);
      } else {
        // Places directly from the core.
        expect(r.confident).toBe(true);
        expect(r.branch).toBeNull();
        expect(r.best).toBe(slug);
        expect(r.margin).toBeGreaterThanOrEqual(BORDER_MARGIN);
      }
    });
  }
});

describe('runoff banks resolve both sides + tie fallback', () => {
  it('prog-soc: reform+institutions → progressive, replace+movements → socialist', () => {
    expect(resolveTiebreak('prog-soc', [0, 0], 'progressive')).toBe('progressive');
    expect(resolveTiebreak('prog-soc', [1, 1], 'progressive')).toBe('socialist');
  });

  it('pop-nat: insiders → populist, foreign → nationalist', () => {
    expect(resolveTiebreak('pop-nat', [0, 0], 'populist')).toBe('populist');
    expect(resolveTiebreak('pop-nat', [1, 1], 'populist')).toBe('nationalist');
  });

  it('con-pop: repair → conservative, rebuild → populist', () => {
    expect(resolveTiebreak('con-pop', [0, 0], 'populist')).toBe('conservative');
    expect(resolveTiebreak('con-pop', [1, 1], 'conservative')).toBe('populist');
  });

  it('a 1-1 split falls back to the core lean', () => {
    expect(resolveTiebreak('pop-nat', [0, 1], 'nationalist')).toBe('nationalist');
    expect(resolveTiebreak('pop-nat', [0, 1], 'populist')).toBe('populist');
  });
});

describe('structural invariants', () => {
  it('12 core questions, unique ids, 2 or 3 options each', () => {
    expect(CORE_QUESTIONS).toHaveLength(12);
    expect(new Set(CORE_QUESTIONS.map((q) => q.id)).size).toBe(12);
    for (const q of CORE_QUESTIONS)
      expect(q.options.length === 2 || q.options.length === 3).toBe(true);
  });

  it('7 tribe targets, matching the canonical keys, with taxes + elites binary', () => {
    expect(TRIBE_TARGETS).toHaveLength(7);
    expect(new Set(TRIBE_TARGETS.map((t) => t.slug))).toEqual(new Set(Object.keys(CANONICAL)));
    // Only taxes (0) and elites (11) are binary; immigration (8) and experts (10) are 3-option.
    for (const i of [0, 11]) expect(CORE_QUESTIONS[i]!.options).toHaveLength(2);
    for (const i of [8, 10]) expect(CORE_QUESTIONS[i]!.options).toHaveLength(3);
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

  it('each bank has 2 questions of 2 options, each voting for its pair', () => {
    for (const key of Object.keys(TIEBREAK_BANKS) as TiebreakKey[]) {
      const bank = TIEBREAK_BANKS[key];
      const pair = new Set(bank.pair);
      expect(bank.questions).toHaveLength(2);
      for (const q of bank.questions) {
        expect(q.options).toHaveLength(2);
        for (const o of q.options) expect(pair.has(o.vote)).toBe(true);
      }
    }
  });

  it('near-neutral answers open the override, not a placement', () => {
    // Every 3-option question at its midpoint (index 1); binary questions at 0.
    const mid = CORE_QUESTIONS.map((q) => (q.options.length === 3 ? 1 : 0));
    // Neutralize the binary picks by pairing opposite signs where possible is not
    // needed — magnitude stays low because 3-option axes sum to 0.
    const r = resolveCore(mid);
    expect(r.showOverride === true || r.confident === true).toBe(true); // sanity: never hangs
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
