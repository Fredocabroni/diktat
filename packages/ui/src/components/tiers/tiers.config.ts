// Single source of truth for the 12-tier ladder presentation layer.
//
// Order, names, AP thresholds, and palette keys MUST stay in lockstep with:
//   - docs/MASTER_PLAN.md §5 (Tier ladder — locked)
//   - supabase/migrations/*_seed_tiers.sql
//   - packages/ap-engine/src/constants.ts (TIER_BANDS)
//
// `paletteKey` resolves to a slot in `tokens.colors.tier` (t0..t11).
// `emblemId` resolves to a component in ./emblems/index.ts.

export interface TierConfigEntry {
  tier: number;
  slug: string;
  name: string;
  apThreshold: number;
  paletteKey: 't0' | 't1' | 't2' | 't3' | 't4' | 't5' | 't6' | 't7' | 't8' | 't9' | 't10' | 't11';
  emblemId:
    | 'citizen'
    | 'voter'
    | 'partisan'
    | 'operative'
    | 'strategist'
    | 'tactician'
    | 'vanguard'
    | 'senator'
    | 'statesman'
    | 'architect'
    | 'legendary'
    | 'mythic';
}

export const TIERS: readonly TierConfigEntry[] = [
  {
    tier: 0,
    slug: 'citizen',
    name: 'Citizen',
    apThreshold: 0,
    paletteKey: 't0',
    emblemId: 'citizen',
  },
  { tier: 1, slug: 'voter', name: 'Voter', apThreshold: 100, paletteKey: 't1', emblemId: 'voter' },
  {
    tier: 2,
    slug: 'partisan',
    name: 'Partisan',
    apThreshold: 300,
    paletteKey: 't2',
    emblemId: 'partisan',
  },
  {
    tier: 3,
    slug: 'operative',
    name: 'Operative',
    apThreshold: 750,
    paletteKey: 't3',
    emblemId: 'operative',
  },
  {
    tier: 4,
    slug: 'strategist',
    name: 'Strategist',
    apThreshold: 1500,
    paletteKey: 't4',
    emblemId: 'strategist',
  },
  {
    tier: 5,
    slug: 'tactician',
    name: 'Tactician',
    apThreshold: 3000,
    paletteKey: 't5',
    emblemId: 'tactician',
  },
  {
    tier: 6,
    slug: 'vanguard',
    name: 'Vanguard',
    apThreshold: 5500,
    paletteKey: 't6',
    emblemId: 'vanguard',
  },
  {
    tier: 7,
    slug: 'senator',
    name: 'Senator',
    apThreshold: 10000,
    paletteKey: 't7',
    emblemId: 'senator',
  },
  {
    tier: 8,
    slug: 'statesman',
    name: 'Statesman',
    apThreshold: 18000,
    paletteKey: 't8',
    emblemId: 'statesman',
  },
  {
    tier: 9,
    slug: 'architect',
    name: 'Architect',
    apThreshold: 30000,
    paletteKey: 't9',
    emblemId: 'architect',
  },
  {
    tier: 10,
    slug: 'legendary',
    name: 'Legendary',
    apThreshold: 47000,
    paletteKey: 't10',
    emblemId: 'legendary',
  },
  {
    tier: 11,
    slug: 'mythic',
    name: 'Mythic',
    apThreshold: 75000,
    paletteKey: 't11',
    emblemId: 'mythic',
  },
] as const;

export function tierByNumber(n: number): TierConfigEntry {
  const entry = TIERS[n];
  if (!entry) throw new Error(`Unknown tier number: ${n}`);
  return entry;
}
