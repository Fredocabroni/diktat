// Source-level pins for the DropCard P2.a selected-state surface.
// vitest.config.ts scopes the suite to Node env, so React rendering
// isn't exercised here; the tests read DropCard.tsx + DropFeedClient.tsx
// as source and assert the structural invariants that end-to-end
// behavior depends on.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const DROP_CARD = readFileSync(new URL('../DropCard.tsx', import.meta.url), 'utf8');
const DROP_FEED = readFileSync(new URL('../DropFeedClient.tsx', import.meta.url), 'utf8');

describe('DropCard — P2.a selected-state surface', () => {
  it('accepts a `selected` prop with values "agree" | "disagree" | null', () => {
    expect(DROP_CARD).toMatch(/export type SelectedStance = 'agree' \| 'disagree' \| null/);
    expect(DROP_CARD).toMatch(/readonly selected\?: SelectedStance/);
  });

  it('passes the selected flag down to each stance button', () => {
    // Agree + Disagree buttons receive a boolean `selected` prop
    // computed from the top-level `selected` value. Skip is never
    // selectable but gains the dimmed treatment when another stance
    // is active.
    expect(DROP_CARD).toMatch(/selected={selected === 'agree'}/);
    expect(DROP_CARD).toMatch(/selected={selected === 'disagree'}/);
    expect(DROP_CARD).toMatch(/dimmed={selected !== null/);
  });

  it('renders a lowercase confirmation pill below the button grid when a stance is selected', () => {
    // "recorded · agree" / "recorded · disagree" — lowercase per voice
    // guide (apps/web should pass copy-linter on this template).
    expect(DROP_CARD).toMatch(/`recorded · \$\{selected\}`/);
    // The confirmation IS gated on selected !== null — unselected
    // state renders no pill.
    expect(DROP_CARD).toMatch(/selected !== null \? \(/);
  });

  it('refuses engagement anti-patterns (no confetti / urgency / exclamation on confirmation)', () => {
    // Explicit assertion: no celebratory language on the confirmation
    // template. The copy-linter CI gate is the authoritative check,
    // but we pin a few of the common anti-patterns here so a future
    // DropCard edit can't quietly introduce them.
    const forbidden = ['confetti', '🎉', '🔥', '🏆', 'Nice', 'awesome', 'Only', 'left', "You've"];
    const template = DROP_CARD.match(/`recorded · \$\{selected\}`/);
    expect(template).not.toBeNull();
    for (const bad of forbidden) {
      // The confirmation template is the pin point, not the whole
      // file (header copy contains "You" references elsewhere, etc.).
      expect(template![0]!).not.toContain(bad);
    }
  });

  it('StanceButton exposes aria-pressed on the selected state', () => {
    // Accessibility invariant: a sticky-on button must announce
    // state via aria-pressed. The visual ring alone is not enough.
    expect(DROP_CARD).toMatch(/aria-pressed=\{selected\}/);
  });
});

describe('DropFeedClient — P2.a wiring', () => {
  it('reads server-side userStance from feed.list topics', () => {
    expect(DROP_FEED).toMatch(/readonly userStance: SelectedStance/);
    expect(DROP_FEED).toMatch(/state\.topic\.userStance/);
  });

  it('maintains per-topic optimistic selected state keyed by topicId', () => {
    expect(DROP_FEED).toMatch(/optimisticStance/);
    expect(DROP_FEED).toMatch(/setOptimisticStance/);
  });

  it('optimistic selection overrides the server stance so the UI responds instantly', () => {
    // The resolver pattern: optimisticStance[topicId] ?? state.topic.userStance.
    expect(DROP_FEED).toMatch(/optimisticStance\[state\.topic\.id\] \?\? state\.topic\.userStance/);
  });

  it('reverts optimistic selection on mutation failure (prior value or absent key)', () => {
    expect(DROP_FEED).toMatch(/priorOptimistic/);
    // The catch block cleans up the optimistic entry rather than
    // leaving the UI stuck on an unsaved selection.
    expect(DROP_FEED).toMatch(/if \(priorOptimistic === undefined\) delete next\[topicId\]/);
  });

  it('keeps the existing red "couldn\'t save" affordance on error', () => {
    expect(DROP_FEED).toMatch(/Couldn&rsquo;t save your stance/);
  });
});

// ---------------------------------------------------------------------------
// A4 — FactExplainerPanel in DropCard
// ---------------------------------------------------------------------------

describe('DropCard — A4 FactExplainerPanel', () => {
  it('declares the factExplainer prop with the shape from feed.list', () => {
    expect(DROP_CARD).toMatch(/factExplainer\?: \{/);
    expect(DROP_CARD).toMatch(/readonly for_summary: string/);
    expect(DROP_CARD).toMatch(/readonly against_summary: string/);
    expect(DROP_CARD).toMatch(/readonly source_url: string/);
    expect(DROP_CARD).toMatch(/readonly posture: 'contested' \| 'single_sided' \| 'empirical'/);
  });

  it('renders FactExplainerPanel conditionally on non-null factExplainer', () => {
    // Pin the conditional render guard so a future edit can't quietly
    // show the panel when the explainer is null (would render empty
    // "for" / "against" labels). Formatter may collapse the ternary
    // to one line; match either single- or multi-line form.
    expect(DROP_CARD).toMatch(/topic\.factExplainer \?/);
    expect(DROP_CARD).toMatch(/<FactExplainerPanel\s+explainer=\{topic\.factExplainer\}/);
  });

  it('contested posture renders both for and against; non-contested renders single', () => {
    // Posture steering is the false-balance guard. If a future refactor
    // flips this logic (always-two-paragraphs regardless of posture),
    // the §11 integrity contract degrades.
    expect(DROP_CARD).toMatch(/isContested[\s\S]*posture === 'contested'/);
    expect(DROP_CARD).toMatch(/FactExplainerPanel\.For/);
    expect(DROP_CARD).toMatch(/FactExplainerPanel\.Against/);
    expect(DROP_CARD).toMatch(/FactExplainerPanel\.Single/);
  });

  it('kicker copy is lowercase + posture-specific (no urgency, no celebration)', () => {
    expect(DROP_CARD).toContain("'the debate'");
    expect(DROP_CARD).toContain("'the data says'");
    expect(DROP_CARD).toContain("'the primary source says'");
    // Anti-pattern pins — no exclamation / hype on the explainer surface.
    const factPanel = DROP_CARD.match(/function FactExplainerPanel[\s\S]*?^}/m);
    expect(factPanel).not.toBeNull();
    for (const bad of ['!', 'BREAKING', 'URGENT', 'MUST READ']) {
      expect(factPanel![0]!).not.toContain(bad);
    }
  });

  it('data-posture attribute exposes posture for addiction-auditor + e2e assertions', () => {
    expect(DROP_CARD).toMatch(/data-posture=\{explainer\.posture\}/);
  });
});
