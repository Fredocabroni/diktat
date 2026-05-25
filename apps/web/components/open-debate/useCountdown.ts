// Local countdown hook driven by a 500ms tick. Server is the source of
// truth for deadline transitions -- this hook only owns the displayed
// seconds-left text. Returns null when no deadline is set.

'use client';

import { useEffect, useState } from 'react';

export function useCountdown(deadlineAt: string | null): number | null {
  const [secondsLeft, setSecondsLeft] = useState<number | null>(() =>
    computeSecondsLeft(deadlineAt),
  );

  useEffect(() => {
    setSecondsLeft(computeSecondsLeft(deadlineAt));
    if (!deadlineAt) return;
    const id = window.setInterval(() => {
      setSecondsLeft(computeSecondsLeft(deadlineAt));
    }, 500);
    return () => window.clearInterval(id);
  }, [deadlineAt]);

  return secondsLeft;
}

function computeSecondsLeft(deadlineAt: string | null): number | null {
  if (!deadlineAt) return null;
  const ms = new Date(deadlineAt).getTime() - Date.now();
  return Math.max(0, Math.floor(ms / 1000));
}
