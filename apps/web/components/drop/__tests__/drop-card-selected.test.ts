// Source-level pins for the DropCard P2.a selected-state surface.
// vitest.config.ts scopes the suite to Node env, so React rendering
// isn't exercised here; the tests read DropCard.tsx + DropFeedClient.tsx
// as source and assert the structural invariants that end-to-end
// behavior depends on.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const DROP_CARD = readFileSync(new URL('../DropCard.tsx', import.meta.url), 'utf8');
const DROP_FEED = readFileSync(new URL('../DropFeedClient.tsx', import.meta.url), 'utf8');

describe('DropCard — choose-then-lock-in surface', () => {
  it('accepts `locked` + `chosen` props typed as SelectedStance', () => {
    expect(DROP_CARD).toMatch(/export type SelectedStance = 'agree' \| 'disagree' \| null/);
    expect(DROP_CARD).toMatch(/readonly locked\?: SelectedStance/);
    expect(DROP_CARD).toMatch(/readonly chosen\?: SelectedStance/);
    expect(DROP_CARD).toMatch(/readonly editing\?: boolean/);
  });

  it('visualSelection: locked view uses `locked`; choose view uses `chosen`', () => {
    // The card computes a single `visualSelection` that drives the
    // sticky-on button. In locked view (locked !== null && !editing)
    // it reflects the server/optimistic stance; otherwise the
    // pre-submit `chosen`.
    expect(DROP_CARD).toMatch(/isLockedView = locked !== null && !editing/);
    expect(DROP_CARD).toMatch(/visualSelection: SelectedStance = isLockedView \? locked : chosen/);
    expect(DROP_CARD).toMatch(/selected={visualSelection === 'agree'}/);
    expect(DROP_CARD).toMatch(/selected={visualSelection === 'disagree'}/);
  });

  it('renders the Lock-it-in button only when a choice is pending and the card is not locked', () => {
    expect(DROP_CARD).toMatch(/LockItInButton/);
    // Gated on (!readOnly && !isLockedView && chosen !== null).
    expect(DROP_CARD).toMatch(/!readOnly && !isLockedView && chosen !== null/);
    // Label is "Lock it in" in the idle state and switches to the
    // lowercase "locking in." while submitting.
    expect(DROP_CARD).toContain("'Lock it in'");
    expect(DROP_CARD).toContain("'locking in.'");
  });

  it('stance buttons are disabled in locked view so tapping cannot bypass "Changed my mind"', () => {
    expect(DROP_CARD).toMatch(/stanceButtonsDisabled = disabled \|\| submitting \|\| isLockedView/);
    expect(DROP_CARD).toMatch(/disabled={stanceButtonsDisabled}/);
  });

  it('renders a lowercase "locked · <stance>" pill in locked view', () => {
    expect(DROP_CARD).toMatch(/`locked · \$\{locked\}`/);
    // The pill only appears in locked view.
    expect(DROP_CARD).toMatch(/!readOnly && isLockedView/);
  });

  it('shows "Changed my mind" link in locked view, hidden in choose view', () => {
    expect(DROP_CARD).toMatch(/ChangeMindButton/);
    expect(DROP_CARD).toMatch(/Changed my mind/);
    // Wired to the onChangeMind callback; disabled while submitting.
    expect(DROP_CARD).toMatch(/onClick={\(\) => onChangeMind\?\.\(\)}/);
  });

  it('renders SplitBar only when in locked view AND a split payload is present', () => {
    expect(DROP_CARD).toMatch(/\{split \? <SplitBar split=\{split\} \/> : null\}/);
  });

  it('refuses engagement anti-patterns on the confirmation + lock-in templates', () => {
    const forbidden = ['confetti', '🎉', '🔥', '🏆', 'Nice', 'awesome', 'Only', 'left', "You've"];
    const lockedPill = DROP_CARD.match(/`locked · \$\{locked\}`/);
    const lockBtn = DROP_CARD.match(/LockItInButton[\s\S]*?Lock it in/);
    expect(lockedPill).not.toBeNull();
    expect(lockBtn).not.toBeNull();
    for (const bad of forbidden) {
      expect(lockedPill![0]!).not.toContain(bad);
      expect(lockBtn![0]!).not.toContain(bad);
    }
  });

  it('StanceButton still exposes aria-pressed on the selected state', () => {
    expect(DROP_CARD).toMatch(/aria-pressed=\{selected\}/);
  });
});

describe('DropFeedClient — choose-then-lock-in wiring', () => {
  it('maintains per-topic chosen / editing / lockedOptimistic state maps', () => {
    expect(DROP_FEED).toMatch(/setChosen/);
    expect(DROP_FEED).toMatch(/setEditing/);
    expect(DROP_FEED).toMatch(/setLockedOptimistic/);
  });

  it('onStance only touches local state — never calls the mutation', () => {
    // The onStance handler must not reference recordShift; the only
    // mutation call site is in onLockIn.
    const onStance = DROP_FEED.match(/const onStance = useCallback\([\s\S]*?\}, \[\]\);/);
    expect(onStance).not.toBeNull();
    expect(onStance![0]!).not.toContain('recordShift');
    expect(onStance![0]!).not.toContain('mutateAsync');
  });

  it('onLockIn is the ONLY place that calls recordShift.mutateAsync', () => {
    // The onLockIn useCallback block is where the mutation fires.
    expect(DROP_FEED).toMatch(/const onLockIn = useCallback\(/);
    expect(DROP_FEED).toMatch(/recordShift\.mutateAsync/);
    // Exactly one mutation call across the file.
    const mutateHits = (DROP_FEED.match(/recordShift\.mutateAsync/g) ?? []).length;
    expect(mutateHits).toBe(1);
  });

  it('tapping the already-chosen button deselects (sets chosen[topic] to absent)', () => {
    // The toggle contract: prev === next → drop the key; else set
    // to the new stance. Pin both branches so a future edit can't
    // quietly make tapping Agree twice write.
    expect(DROP_FEED).toMatch(/if \(prev === next\) \{/);
    expect(DROP_FEED).toMatch(/delete draft\[topicId\]/);
  });

  it('on successful lock-in: clears chosen + editing, sets lockedOptimistic', () => {
    expect(DROP_FEED).toMatch(
      /setLockedOptimistic\(\(current\) => \(\{ \.\.\.current, \[topicId\]: chosenStance \}\)\)/,
    );
  });

  it('on lock-in failure: keeps chosen + editing so the retry is one tap on Lock it in', () => {
    // The catch block only flips saveErrorTopicId — it must not
    // wipe chosen / editing / lockedOptimistic.
    const catchBlock = DROP_FEED.match(/\} catch \{[\s\S]*?\}/);
    expect(catchBlock).not.toBeNull();
    expect(catchBlock![0]!).not.toContain('setChosen');
    expect(catchBlock![0]!).not.toContain('setEditing');
    expect(catchBlock![0]!).not.toContain('setLockedOptimistic');
  });

  it('onChangeMind pre-selects the current locked stance in chosen + flips editing=true', () => {
    expect(DROP_FEED).toMatch(
      /setEditing\(\(current\) => \(\{ \.\.\.current, \[topicId\]: true \}\)\)/,
    );
    expect(DROP_FEED).toMatch(
      /setChosen\(\(current\) => \(\{ \.\.\.current, \[topicId\]: currentLocked \}\)\)/,
    );
  });

  it('effective locked = optimistic override ?? server userStance (reload path)', () => {
    // The DropFlow derives locked from the override map first,
    // falling through to topic.userStance. This is what makes a
    // reload of an already-voted topic render as locked.
    expect(DROP_FEED).toMatch(/lockedOverride !== undefined \? lockedOverride : topic\.userStance/);
  });

  it('getSplit query is gated on isLockedView — no fetch while the user is still choosing', () => {
    expect(DROP_FEED).toMatch(/trpc\.feed\.getSplit\.useQuery\(/);
    expect(DROP_FEED).toMatch(/enabled: isLockedView/);
  });

  it('keeps the red "couldn\'t save" affordance on error; copy points to Lock it in', () => {
    expect(DROP_FEED).toMatch(/Couldn&rsquo;t save your stance\. Tap Lock it in to retry/);
  });

  it('fresh clientKey is minted on first lock-in; retained on failure for idempotent retry', () => {
    // Reuse-if-present pattern is preserved so a mid-flight failure
    // does not cause a double-write after retry.
    expect(DROP_FEED).toMatch(/pendingKeys\.current\.get\(topicId\)/);
    expect(DROP_FEED).toMatch(/pendingKeys\.current\.set\(topicId, clientKey\)/);
    expect(DROP_FEED).toMatch(/pendingKeys\.current\.delete\(topicId\)/);
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
