import { describe, expect, it } from 'vitest';
import { TIERS, tierByNumber } from '../src/components/tiers/tiers.config.js';
import { EMBLEMS } from '../src/components/tiers/emblems/index.js';
import { tier as tierTokens } from '../src/tokens/colors.js';

describe('tiers.config — invariants', () => {
  it('contains exactly 12 entries', () => {
    expect(TIERS).toHaveLength(12);
  });

  it('tier numbers are 0..11 in order', () => {
    TIERS.forEach((entry, idx) => {
      expect(entry.tier).toBe(idx);
    });
  });

  it('AP thresholds are strictly monotonically increasing', () => {
    for (let i = 1; i < TIERS.length; i++) {
      const prev = TIERS[i - 1]!;
      const curr = TIERS[i]!;
      expect(curr.apThreshold).toBeGreaterThan(prev.apThreshold);
    }
  });

  it('all slugs are unique', () => {
    const slugs = TIERS.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('all names are unique', () => {
    const names = TIERS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every emblemId resolves to a real emblem component', () => {
    TIERS.forEach((entry) => {
      expect(EMBLEMS[entry.emblemId]).toBeDefined();
    });
  });

  it('every paletteKey resolves to a real palette in tokens.tier', () => {
    TIERS.forEach((entry) => {
      expect(tierTokens[entry.paletteKey]).toBeDefined();
    });
  });

  it('mythic is tier 11 with the holographic palette', () => {
    const mythic = tierByNumber(11);
    expect(mythic.name).toBe('Mythic');
    expect(mythic.paletteKey).toBe('t11');
    expect(mythic.apThreshold).toBe(75000);
  });

  it('tierByNumber throws for out-of-range input', () => {
    expect(() => tierByNumber(12)).toThrow();
    expect(() => tierByNumber(-1)).toThrow();
  });

  it('locked tier names match MASTER_PLAN §5', () => {
    expect(TIERS[4]!.name).toBe('Strategist');
    expect(TIERS[6]!.name).toBe('Vanguard');
    expect(TIERS[10]!.name).toBe('Legendary');
    expect(TIERS[11]!.name).toBe('Mythic');
  });
});
