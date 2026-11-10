// Source-level pins for the feed skip surface.
// Node-env tests; no React rendering. We assert the structural
// invariants that end-to-end behaviour depends on:
//
//   * Skip never calls recordShift and never counts as a stance.
//   * Skip collapses the card to SkippedCard.
//   * Undo clears the collapsed state (restores the full card in
//     place; a locked vote / split survives because we never
//     mutate chosen / locked / editing on skip).
//   * The next topic container is scrolled into view, honoring
//     prefers-reduced-motion.
//   * Skipped topic ids are persisted in sessionStorage under a
//     namespaced key, wrapped in try/catch.
//   * Skipping the last card: no scrollIntoView call.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const DROP_FEED = readFileSync(new URL('../DropFeedClient.tsx', import.meta.url), 'utf8');
const SKIPPED_CARD = readFileSync(new URL('../SkippedCard.tsx', import.meta.url), 'utf8');

describe('SkippedCard — slim collapsed row', () => {
  it('renders the headline, truncated, plus "skipped · undo"', () => {
    // headline rendered inside a .truncate span (one-line clamp
    // via tailwind). The full headline also lives on the title
    // attribute for a11y / tooltip.
    expect(SKIPPED_CARD).toMatch(/className="min-w-0 flex-1 truncate"/);
    expect(SKIPPED_CARD).toMatch(/title=\{headline\}/);
    expect(SKIPPED_CARD).toMatch(/>skipped</);
    // "undo" renders inside a multi-line <button>, so match the
    // bare word (whitespace-delimited) rather than the closing tag.
    expect(SKIPPED_CARD).toMatch(/\bundo\b/);
  });

  it('copy is lowercase + neutral (no celebration, no urgency)', () => {
    // "skipped" and "undo" are the only user-facing strings. They
    // are lowercase per the voice guide. The copy-linter CI gate
    // is authoritative; pin here so a future edit can't quietly
    // introduce capitals or exclamation.
    const slimRow = SKIPPED_CARD.match(/>skipped</);
    const undoBtn = SKIPPED_CARD.match(/\bundo\b/);
    expect(slimRow).not.toBeNull();
    expect(undoBtn).not.toBeNull();
    // Pin the slim-row block (JSX only — the component name
    // `SkippedCard` legitimately appears in the file header +
    // export). A future edit cannot slip capitalised or
    // celebratory copy into the rendered output.
    const jsxBody = SKIPPED_CARD.match(/return \([\s\S]*?\);/);
    expect(jsxBody).not.toBeNull();
    const forbidden = ['SKIPPED', 'UNDO', '!', 'all caught up', '🎉', 'Nice'];
    for (const bad of forbidden) {
      expect(jsxBody![0]!).not.toContain(bad);
    }
  });

  it('exposes stable data-component hooks for e2e / addiction-auditor', () => {
    expect(SKIPPED_CARD).toMatch(/data-component="SkippedCard"/);
    expect(SKIPPED_CARD).toMatch(/data-component="SkippedCard\.Headline"/);
    expect(SKIPPED_CARD).toMatch(/data-component="SkippedCard\.UndoButton"/);
  });

  it('wraps onUndo in a plain button type="button" so it never triggers an enclosing form', () => {
    expect(SKIPPED_CARD).toMatch(/type="button"/);
    expect(SKIPPED_CARD).toMatch(/onClick=\{onUndo\}/);
  });
});

describe('DropFeedClient — skip wiring', () => {
  it('onStance("skip", ...) delegates to onSkip — it does NOT call recordShift', () => {
    // The skip branch must call onSkip and return BEFORE touching
    // the mutation. Pin both: the explicit guard and the fact that
    // onSkip itself does not reference recordShift.
    expect(DROP_FEED).toMatch(/if \(action === 'skip'\) \{\s*onSkip\(topicId, allTopicIds\);/);
    const onSkip = DROP_FEED.match(/const onSkip = useCallback\([\s\S]*?\[skipped\],\s*\);/);
    expect(onSkip).not.toBeNull();
    expect(onSkip![0]!).not.toContain('recordShift');
    expect(onSkip![0]!).not.toContain('mutateAsync');
  });

  it('onSkip never mutates chosen / editing / lockedOptimistic — a locked vote stands', () => {
    // The whole point: skip is a presentation-only state. Any
    // server-committed stance must survive a skip.
    const onSkip = DROP_FEED.match(/const onSkip = useCallback\([\s\S]*?\[skipped\],\s*\);/);
    expect(onSkip).not.toBeNull();
    expect(onSkip![0]!).not.toContain('setChosen');
    expect(onSkip![0]!).not.toContain('setEditing');
    expect(onSkip![0]!).not.toContain('setLockedOptimistic');
  });

  it('renders SkippedCard instead of DropFlow when the topic is in the skipped map', () => {
    expect(DROP_FEED).toMatch(/skipped\[state\.topic\.id\] \?/);
    expect(DROP_FEED).toMatch(/<SkippedCard/);
    expect(DROP_FEED).toMatch(/onUndo=\{\(\) => onUndoSkip\(state\.topic\.id\)\}/);
  });

  it('onUndoSkip removes the topic id from the skipped map and persists', () => {
    expect(DROP_FEED).toMatch(/const onUndoSkip = useCallback/);
    // The implementation deletes the key and writes the draft keys
    // back to storage so a same-tab reload reflects the undo.
    expect(DROP_FEED).toMatch(/delete draft\[topicId\]/);
    expect(DROP_FEED).toMatch(/writeSkippedToStorage\(Object\.keys\(draft\)\)/);
  });

  it('smooth-scrolls the next non-skipped topic into view; respects prefers-reduced-motion', () => {
    expect(DROP_FEED).toMatch(
      /\.scrollIntoView\(\{[\s\S]*behavior: prefersReducedMotion\(\) \? 'auto' : 'smooth'/,
    );
  });

  it('skipping the last card: no scrollIntoView call (early return on last index)', () => {
    // The onSkip body returns when `myIdx === allTopicIds.length - 1`.
    // Pin the guard so a future refactor cannot accidentally emit a
    // scroll that looks celebratory ("all caught up!").
    expect(DROP_FEED).toMatch(/myIdx === allTopicIds\.length - 1/);
  });

  it('persists skipped ids in sessionStorage under a namespaced key, wrapped in try/catch', () => {
    expect(DROP_FEED).toMatch(/SKIPPED_STORAGE_KEY = 'diktat:feed:skipped:v1'/);
    // Both reader + writer live in try/catch so a private window or
    // disabled site data degrades to in-memory only.
    const reader = DROP_FEED.match(/function readSkippedFromStorage[\s\S]*?^}/m);
    const writer = DROP_FEED.match(/function writeSkippedToStorage[\s\S]*?^}/m);
    expect(reader).not.toBeNull();
    expect(writer).not.toBeNull();
    expect(reader![0]!).toContain('try {');
    expect(reader![0]!).toContain('} catch {');
    expect(writer![0]!).toContain('try {');
    expect(writer![0]!).toContain('} catch {');
  });

  it('hydrates the skipped map from sessionStorage ONCE on mount (same-tab reload)', () => {
    // A `useEffect` with an empty dep array reads storage and
    // seeds the skipped state. New session (fresh tab) sees an
    // empty key and shows everything.
    expect(DROP_FEED).toMatch(/useEffect\(\(\) => \{\s*const ids = readSkippedFromStorage\(\);/);
  });

  it('writes the updated id array back on skip (new entry persists across same-tab reload)', () => {
    // On skip, the onSkip body computes the next skipped map and
    // writes its keys to storage in the same tick so a same-tab
    // reload reflects the collapse.
    expect(DROP_FEED).toMatch(/writeSkippedToStorage\(Object\.keys\(nextState\)\)/);
  });
});
