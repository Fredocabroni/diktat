// Source-level pins for the Take 5 archive stack (P4 PR B).
// vitest.config.ts scopes the suite to Node env, so React rendering
// isn't exercised here; the tests read Take5StackClient.tsx as
// source and assert the structural invariants that end-to-end
// behavior and the addiction-auditor contract depend on.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const TAKE5 = readFileSync(new URL('../Take5StackClient.tsx', import.meta.url), 'utf8');

describe('Take5StackClient — wiring', () => {
  it('uses trpc.take5.getStack as the query source', () => {
    expect(TAKE5).toMatch(/trpc\.take5\.getStack\.useQuery\(\)/);
  });

  it('uses trpc.take5.recordShift as the mutation', () => {
    expect(TAKE5).toMatch(/trpc\.take5\.recordShift\.useMutation\(\)/);
  });

  it('reuses the same DropCard component Home renders', () => {
    expect(TAKE5).toMatch(/from '\.\.\/drop\/DropCard'/);
    expect(TAKE5).toMatch(/<DropCard/);
  });

  it('passes afterPosition ∈ {-1, +1} on agree/disagree', () => {
    // The take5 Zod schema accepts -2..+2 but the UI only emits ±1 —
    // matches DropFeedClient.
    expect(TAKE5).toMatch(/afterPosition: action === 'agree' \? 1 : -1/);
  });

  it('mints a per-topic clientKey and retains it on failure', () => {
    expect(TAKE5).toMatch(/pendingKeys/);
    expect(TAKE5).toMatch(/crypto\.randomUUID\(\)/);
    // On success the key is cleared; on failure it's retained (no
    // delete in the catch block).
    expect(TAKE5).toMatch(/pendingKeys\.current\.delete\(card\.id\)/);
  });

  it('advances the local cursor on BOTH stance and skip', () => {
    // Autonomy: skip pops the card without writing a shift. The
    // streak only credits actual opinion_shifts rows, so a skip-
    // through session honestly earns nothing.
    expect(TAKE5).toMatch(/if \(action === 'skip'\)/);
    expect(TAKE5).toMatch(/setCursor\(\(c\) => c \+ 1\)/);
  });
});

describe('Take5StackClient — done state', () => {
  it('renders a check tick, not confetti', () => {
    // The ONLY celebratory affordance in the done PANEL is a single
    // ✓ character. No TierUpAnimation, no confetti, no particle
    // count, no next-session nudge. Scoped to the done panel body
    // (not the whole file) because the file's own comments name
    // the anti-patterns the test is guarding against.
    const doneStart = TAKE5.indexOf('function DonePanel');
    const doneEnd = TAKE5.indexOf('function ', doneStart + 1);
    const donePanel = TAKE5.slice(doneStart, doneEnd > doneStart ? doneEnd : doneStart + 2000);
    const forbidden = [
      'confetti',
      '🎉',
      '🔥',
      '🏆',
      'TierUp',
      'particles',
      'come back',
      'tomorrow',
      "don't miss",
      'last chance',
      'running out',
      'almost gone',
      'limited',
      'streak!',
    ];
    for (const bad of forbidden) {
      expect(donePanel.toLowerCase()).not.toContain(bad.toLowerCase());
    }
    // Positive assertion: the done panel contains the single tick.
    expect(donePanel).toMatch(/Take5StackClient\.Done/);
    expect(donePanel).toMatch(/✓/);
  });

  it('done copy is one short line, lowercase', () => {
    // Dry voice: single bare line, no exclamation, no urgency.
    expect(TAKE5).toMatch(/all done\./);
    const doneBlock = TAKE5.slice(TAKE5.indexOf('Take5StackClient.Done'));
    expect(doneBlock).not.toMatch(/!/);
  });

  it('offers a Home link out of the done state', () => {
    // Autonomy ramp — the user is never trapped on the done screen.
    const doneBlock = TAKE5.slice(TAKE5.indexOf('Take5StackClient.Done'));
    expect(doneBlock).toMatch(/href="\/"/);
    expect(doneBlock).toMatch(/Back to Home/);
  });
});

describe('Take5StackClient — empty / error state', () => {
  it('renders one honest line + a Home link when the archive is empty', () => {
    expect(TAKE5).toMatch(/Nothing in the archive right now\./);
    expect(TAKE5).toMatch(/Take5StackClient\.Empty/);
  });

  it('fails closed on getStack error with no stack rendered', () => {
    // The error branch MUST NOT render DropCard — a stack we can't
    // trust is worse than nothing. Mirrors the server-side fail-
    // closed in take5.getStack.
    expect(TAKE5).toMatch(/Couldn't load the archive\./);
    expect(TAKE5).toMatch(/stack\.error/);
  });

  it('empty-state copy carries no urgency or scarcity phrasing', () => {
    const emptyBlock = TAKE5.slice(TAKE5.indexOf('Take5StackClient.Empty'));
    const forbidden = [
      'last chance',
      'running out',
      'almost gone',
      'limited',
      'miss out',
      'come back',
      'tomorrow',
    ];
    for (const bad of forbidden) {
      expect(emptyBlock.toLowerCase()).not.toContain(bad.toLowerCase());
    }
  });
});

describe('Take5StackClient — N of N counter', () => {
  it('renders a lowercase "card X of Y" counter above the card', () => {
    expect(TAKE5).toMatch(/Take5StackClient\.Counter/);
    expect(TAKE5).toMatch(/card \{cursor \+ 1\} of \{total\}/);
  });
});
