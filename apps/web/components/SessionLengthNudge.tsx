// Mounts the §12 "you've been here 30 minutes, take a break?" nudge
// on the (app) shell.
//
// Contract (P4 pre-launch batch, matches docs/ADDICTION_ARCHITECTURE
// §11.5 + §12):
//   - After 30 minutes of continuous active use, show ONE gentle,
//     dismissible banner above the bottom tab bar. The rest of the
//     page stays interactive — the banner never blocks content.
//   - At most ONCE per tab session. `sessionStorage` scopes the
//     "already shown" flag to the current tab lifetime so a tab close
//     (or a hard refresh after one) resets the budget. There is no
//     snooze loop — picking "Keep going" closes the banner for the
//     rest of the session.
//   - "Close for now" ALSO closes for the rest of the session; the
//     label difference is intent, not timer-state. Both buttons stamp
//     the shown-flag.
//   - No urgency, no scarcity, no "come back tomorrow" copy. The
//     visual primitive owns the strings; this wrapper only decides
//     when it mounts.

'use client';

import { SessionNudgeSheet } from '@diktat/ui';
import { useEffect, useState } from 'react';

const START_KEY = 'diktat:session-nudge:start-ts';
const SHOWN_KEY = 'diktat:session-nudge:shown';
const NUDGE_THRESHOLD_MIN = 30;
/** Reset the session window if the tab was hidden for this long or
 *  longer. A user who left the tab open overnight and comes back the
 *  next day should get a fresh 30-minute window, not an instant nudge. */
const IDLE_RESET_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 30 * 1000;

function readStartTs(): number | null {
  try {
    const raw = sessionStorage.getItem(START_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function writeStartTs(ts: number): void {
  try {
    sessionStorage.setItem(START_KEY, String(ts));
  } catch {
    // Private browsing — degrade silently. The nudge runs from the
    // current mount instead of persisting across reloads.
  }
}

function readShown(): boolean {
  try {
    return sessionStorage.getItem(SHOWN_KEY) === '1';
  } catch {
    return false;
  }
}

function writeShown(): void {
  try {
    sessionStorage.setItem(SHOWN_KEY, '1');
  } catch {
    // Private browsing — fallthrough; the in-memory `shown` state keeps
    // the once-per-mount guarantee for this tab.
  }
}

export function SessionLengthNudge(): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    // Initialise or resume the session timer and shown-flag.
    const now = Date.now();
    let startTs = readStartTs();
    if (startTs === null) {
      startTs = now;
      writeStartTs(startTs);
    }
    if (readShown()) {
      setShown(true);
    }

    function tick(): void {
      if (readShown()) {
        setShown(true);
        return;
      }
      const elapsedMin = (Date.now() - startTs!) / 60_000;
      if (elapsedMin >= NUDGE_THRESHOLD_MIN) {
        setOpen(true);
        writeShown();
        setShown(true);
      }
    }

    tick();
    const interval = window.setInterval(tick, POLL_INTERVAL_MS);

    function onVisibility(): void {
      if (document.visibilityState !== 'visible') return;
      // A long tab-hidden interval resets the session window — a user
      // returning after >5 minutes of inactivity gets a fresh counter.
      const resumedAt = Date.now();
      if (startTs !== null && resumedAt - startTs > IDLE_RESET_MS) {
        startTs = resumedAt;
        writeStartTs(startTs);
      }
      tick();
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  function handleContinue(): void {
    // "Keep going" — close the sheet, stamp shown, no re-fire this
    // session. No snooze loop.
    setOpen(false);
    writeShown();
    setShown(true);
  }

  function handleLater(): void {
    // "Close for now" — close the sheet, stamp shown, no re-fire this
    // session. The label difference from "Keep going" is intent, not
    // timer-state.
    setOpen(false);
    writeShown();
    setShown(true);
  }

  // Once-per-session guarantee: after the shown flag flips, the
  // component renders null for the rest of the tab's lifetime.
  if (shown && !open) return null;

  return <SessionNudgeSheet open={open} onContinue={handleContinue} onLater={handleLater} />;
}
