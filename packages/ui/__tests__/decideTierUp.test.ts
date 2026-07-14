import { describe, expect, it } from 'vitest';

import { decideTierUp } from '../src/components/tiers/decideTierUp.js';

describe('decideTierUp', () => {
  it('seeds silently on first-ever observation (absorbs the #89 backfill 0->1)', () => {
    // Existing user whose tier_id was corrected 0->1 by the backfill; first load
    // has no stored mark. Must NOT celebrate that already-past crossing.
    expect(decideTierUp(null, 1)).toEqual({ kind: 'seed', mark: 1 });
    expect(decideTierUp(null, 0)).toEqual({ kind: 'seed', mark: 0 });
    expect(decideTierUp(null, 11)).toEqual({ kind: 'seed', mark: 11 });
  });

  it('celebrates a real up-crossing with from/to/severity', () => {
    expect(decideTierUp(1, 2)).toEqual({
      kind: 'celebrate',
      fromTier: 1,
      toTier: 2,
      severity: 1,
    });
    // Landing on tier 3 (payout unlock) floors to severity 2.
    expect(decideTierUp(2, 3)).toEqual({
      kind: 'celebrate',
      fromTier: 2,
      toTier: 3,
      severity: 2,
    });
  });

  it('celebrates a multi-tier jump ONCE (not stepped)', () => {
    expect(decideTierUp(1, 4)).toEqual({
      kind: 'celebrate',
      fromTier: 1,
      toTier: 4,
      severity: 4, // base 2 + (jump 3 - 1) = 4
    });
  });

  it('re-arms silently on demotion (AP loss lowered the tier)', () => {
    expect(decideTierUp(4, 2)).toEqual({ kind: 're-arm', mark: 2 });
    expect(decideTierUp(1, 0)).toEqual({ kind: 're-arm', mark: 0 });
  });

  it('does nothing when the tier is unchanged (idempotent across refetches)', () => {
    expect(decideTierUp(3, 3)).toEqual({ kind: 'none' });
    expect(decideTierUp(0, 0)).toEqual({ kind: 'none' });
  });
});
