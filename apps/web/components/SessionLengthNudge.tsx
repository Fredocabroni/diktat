// Mounts the §12 "you've been here 30 min, take a break?" sheet on the
// (app) shell. Tracks the session start time in localStorage so a
// hard-refresh inside the same continuous session preserves the
// elapsed counter, and a fresh tab after a 5-minute idle resets it.
//
// Per ADDICTION_ARCHITECTURE.md §12: this is the trust-up framing.
// The buttons are "I'll come back later" (closes the sheet AND resets
// the timer so we don't immediately re-trigger) and "Just 5 more
// minutes" (closes the sheet, sets a 5-minute extension before the
// next prompt).

'use client';

import { SessionNudgeSheet } from '@diktat/ui';
import { useEffect, useState } from 'react';

const STORAGE_KEY = 'diktat:session-nudge:start-ts';
const NUDGE_THRESHOLD_MIN = 30;
const SNOOZE_EXTENSION_MIN = 5;
const IDLE_RESET_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 30 * 1000;

interface SessionState {
  startTs: number;
  /** Effective offset added to the nudge threshold by snoozes. */
  snoozeMinutes: number;
}

function readState(): SessionState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SessionState>;
    if (typeof parsed.startTs !== 'number') return null;
    return {
      startTs: parsed.startTs,
      snoozeMinutes: typeof parsed.snoozeMinutes === 'number' ? parsed.snoozeMinutes : 0,
    };
  } catch {
    return null;
  }
}

function writeState(state: SessionState | null): void {
  try {
    if (state === null) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }
  } catch {
    // Private browsing — degrade silently. The nudge will run from the
    // current mount instead of persisting across reloads.
  }
}

export function SessionLengthNudge(): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [minutesElapsed, setMinutesElapsed] = useState(0);

  useEffect(() => {
    // Initialize or resume the session timer. If the last seen
    // timestamp is older than IDLE_RESET_MS in the past, treat it as a
    // new session.
    const now = Date.now();
    const existing = readState();
    let state: SessionState;
    if (existing === null || now - existing.startTs > 24 * 60 * 60 * 1000) {
      state = { startTs: now, snoozeMinutes: 0 };
      writeState(state);
    } else {
      state = existing;
    }

    function tick(): void {
      const elapsedMin = (Date.now() - state.startTs) / 60_000;
      setMinutesElapsed(elapsedMin);
      if (!open && elapsedMin >= NUDGE_THRESHOLD_MIN + state.snoozeMinutes) {
        setOpen(true);
      }
    }

    tick();
    const interval = window.setInterval(tick, POLL_INTERVAL_MS);

    function onVisibility(): void {
      if (document.visibilityState !== 'visible') return;
      const stored = readState();
      if (stored === null) return;
      // If the tab was hidden long enough that the session is stale,
      // reset to a fresh session window.
      const lastTouch = Date.now();
      if (
        lastTouch - stored.startTs > IDLE_RESET_MS &&
        elapsedSince(stored) > NUDGE_THRESHOLD_MIN
      ) {
        state = { startTs: lastTouch, snoozeMinutes: 0 };
        writeState(state);
        setOpen(false);
      }
      tick();
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [open]);

  function handleContinue(): void {
    setOpen(false);
    const existing = readState();
    if (existing) {
      writeState({
        ...existing,
        snoozeMinutes: existing.snoozeMinutes + SNOOZE_EXTENSION_MIN,
      });
    }
  }

  function handleLater(): void {
    setOpen(false);
    // Reset the session window so the nudge doesn't re-fire on the
    // user's next keystroke. They've expressed an intent to leave.
    writeState({ startTs: Date.now(), snoozeMinutes: 0 });
    setMinutesElapsed(0);
  }

  return (
    <SessionNudgeSheet
      open={open}
      minutesElapsed={minutesElapsed}
      onContinue={handleContinue}
      onLater={handleLater}
    />
  );
}

function elapsedSince(state: SessionState): number {
  return (Date.now() - state.startTs) / 60_000;
}
