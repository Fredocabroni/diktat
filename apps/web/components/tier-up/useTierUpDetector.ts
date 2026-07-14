'use client';

// Client-derived tier-up detection. Reads the server-authoritative
// `user.me.tier_id` (correct since the #89 settlement fix) and celebrates a
// crossing exactly once by tracking a durable high-water mark in localStorage.
//
// Reliability contract (see PR plan §B):
//   - Seed-on-first-init: the first-ever observation for a user seeds the mark
//     to the current tier WITHOUT celebrating — this absorbs the #89 backfill
//     (0->1) and any pre-launch climb, so only post-launch crossings fire.
//   - No false-fire: once shown, the mark advances to the destination tier, so
//     a refetch / navigation / reload sees `tier === mark` and stays silent.
//     An in-session `showingRef` guard blocks re-enqueue while a celebration
//     is already up.
//   - No miss: the mark advances on DISMISS (animation complete), not on
//     detect, so a reload mid-animation still has `tier > mark` and re-shows.
//   - Demotion (AP loss lowers the tier) is silent and re-arms the mark.

import { decideTierUp, type TierNumber, type TierUpSeverity } from '@diktat/ui';
import { useCallback, useEffect, useRef, useState } from 'react';

import { trpc } from '../../lib/trpc';

const KEY_PREFIX = 'diktat:tier-celebrated:';

export interface PendingCrossing {
  readonly fromTier: TierNumber;
  readonly toTier: TierNumber;
  readonly severity: TierUpSeverity;
}

function readMark(userId: string): number | null {
  try {
    const raw = window.localStorage.getItem(KEY_PREFIX + userId);
    if (raw === null) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null; // private mode / disabled storage — treat as unseen
  }
}

function writeMark(userId: string, tier: number): void {
  try {
    window.localStorage.setItem(KEY_PREFIX + userId, String(tier));
  } catch {
    // Non-fatal: worst case a celebration can repeat on a device that blocks
    // storage. Never throw from the detection path.
  }
}

export function useTierUpDetector(): {
  pending: PendingCrossing | null;
  dismiss: () => void;
} {
  const me = trpc.user.me.useQuery();
  const [pending, setPending] = useState<PendingCrossing | null>(null);
  // True while a celebration is on screen — prevents a refetch from stacking a
  // duplicate for the same crossing.
  const showingRef = useRef(false);

  const userId = me.data?.id ?? null;
  const tier = typeof me.data?.tier_id === 'number' ? me.data.tier_id : null;

  useEffect(() => {
    if (userId === null || tier === null) return;
    if (showingRef.current) return;

    const decision = decideTierUp(readMark(userId), tier as TierNumber);
    switch (decision.kind) {
      case 'seed': // absorbs pre-launch climb + the #89 backfill
      case 're-arm': // demotion: store lower, no celebration
        writeMark(userId, decision.mark);
        break;
      case 'celebrate':
        showingRef.current = true;
        setPending({
          fromTier: decision.fromTier,
          toTier: decision.toTier,
          severity: decision.severity,
        });
        // Mark advances on dismiss(), not here (reload-mid-anim must re-show).
        break;
      case 'none':
        break;
    }
  }, [userId, tier]);

  const dismiss = useCallback(() => {
    if (userId !== null && pending !== null) {
      writeMark(userId, pending.toTier); // advance now that it's been shown
    }
    showingRef.current = false;
    setPending(null);
  }, [userId, pending]);

  return { pending, dismiss };
}
