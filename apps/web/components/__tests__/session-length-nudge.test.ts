// Source-level pins for the once-per-session nudge wrapper
// (P4 pre-launch batch).
//
// The runtime behavior is DOM-shaped (setInterval, sessionStorage,
// visibilitychange); vitest.config.ts scopes the apps/web suite to
// the Node env, so these tests read SessionLengthNudge.tsx as source
// and assert the structural invariants the operator contract depends
// on. Mirrors the pattern used by drop-card-selected.test.ts.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const NUDGE = readFileSync(new URL('../SessionLengthNudge.tsx', import.meta.url), 'utf8');

describe('SessionLengthNudge — once-per-session guarantee', () => {
  it('uses sessionStorage (not localStorage) for the shown flag', () => {
    // sessionStorage scopes the budget to the tab lifetime. A new tab
    // (or a fresh browser launch) gets a new 30-minute window. The
    // previous implementation used localStorage which carried the
    // snooze state across tabs and days; §11.5 trust-up requires the
    // nudge to be rare and recoverable.
    expect(NUDGE).toMatch(/sessionStorage\.getItem\(SHOWN_KEY\)/);
    expect(NUDGE).toMatch(/sessionStorage\.setItem\(SHOWN_KEY/);
    expect(NUDGE).not.toMatch(/localStorage\.(get|set)Item\(SHOWN_KEY/);
  });

  it('has NO snooze mechanism — a dismiss closes the sheet for the whole session', () => {
    // Operator contract: "at most once per session". The previous
    // version re-fired after a 5-minute snooze; the current one
    // stamps the shown flag on BOTH button handlers and renders null
    // for the rest of the session.
    expect(NUDGE).not.toMatch(/snoozeMinutes/);
    expect(NUDGE).not.toMatch(/SNOOZE_EXTENSION_MIN/);
    // The handleContinue AND handleLater branches both call
    // writeShown() — i.e. "Keep going" and "Close for now" have the
    // same once-per-session effect.
    const continueBlock = NUDGE.slice(
      NUDGE.indexOf('function handleContinue'),
      NUDGE.indexOf('function handleLater'),
    );
    const laterBlock = NUDGE.slice(NUDGE.indexOf('function handleLater'));
    expect(continueBlock).toMatch(/writeShown\(\)/);
    expect(laterBlock).toMatch(/writeShown\(\)/);
  });

  it('refuses to re-mount once the shown flag is set', () => {
    // Once-per-tab guarantee at the mount boundary. The component
    // renders null when the shown flag is set AND the sheet is not
    // currently open — covers both the "pre-threshold" idle state
    // and the "post-dismiss" state.
    expect(NUDGE).toMatch(/if \(shown && !open\) return null/);
  });

  it('threshold is 30 minutes', () => {
    expect(NUDGE).toMatch(/NUDGE_THRESHOLD_MIN\s*=\s*30/);
  });

  it('resets the session window after >5 minutes of visibility idle', () => {
    // A user who leaves the tab open overnight should NOT get an
    // instant nudge on return. The visibilitychange handler compares
    // the resume timestamp against the last startTs and bumps forward
    // when the gap exceeds IDLE_RESET_MS.
    expect(NUDGE).toMatch(/IDLE_RESET_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000/);
    expect(NUDGE).toMatch(/resumedAt - startTs > IDLE_RESET_MS/);
  });

  it('mounts the UI primitive without a minutesElapsed prop (banner shows the fixed "30 minutes" line)', () => {
    // Previous version passed `minutesElapsed={state}` so the sheet
    // headline read the live counter — "You've been here 42 minutes".
    // The operator contract fixed the headline at "30 minutes" so the
    // prop is gone from the primitive. Catch a regression that reads
    // it back.
    expect(NUDGE).not.toMatch(/minutesElapsed=/);
  });
});
