// Pure decision core for the client-derived tier-up detector. Given the last
// celebrated tier (the durable "high-water mark", or null if never seen) and
// the currently-observed tier, decide what to do. No IO, no React, no storage —
// so the branching that matters is unit-testable in isolation; the hook wraps
// this with localStorage + a "showing" guard + advance-on-dismiss.

import type { TierNumber } from './TierBadge.types.js';
import { tierUpSeverity, type TierUpSeverity } from './tierUpSeverity.js';

export type TierUpDecision =
  | { readonly kind: 'seed'; readonly mark: number } // first-ever sight: store, do NOT celebrate
  | {
      readonly kind: 'celebrate';
      readonly fromTier: TierNumber;
      readonly toTier: TierNumber;
      readonly severity: TierUpSeverity;
    }
  | { readonly kind: 're-arm'; readonly mark: number } // demotion: store lower, do NOT celebrate
  | { readonly kind: 'none' };

/**
 * @param previous last celebrated tier, or null on first-ever observation
 * @param current  currently-observed (server-authoritative) tier
 */
export function decideTierUp(previous: number | null, current: TierNumber): TierUpDecision {
  // Seed-on-first-init: absorbs the #89 backfill (0->1) and any pre-launch
  // climb, so only post-launch crossings ever celebrate.
  if (previous === null) return { kind: 'seed', mark: current };

  // A real up-crossing — one decision for the whole jump (1->4 celebrates once,
  // not stepped), severity computed from from/to.
  if (current > previous) {
    const fromTier = previous as TierNumber;
    return {
      kind: 'celebrate',
      fromTier,
      toTier: current,
      severity: tierUpSeverity(fromTier, current),
    };
  }

  // Demotion (AP loss lowered the tier): silent, and re-arm to the lower tier
  // so a future re-cross celebrates again.
  if (current < previous) return { kind: 're-arm', mark: current };

  return { kind: 'none' };
}
