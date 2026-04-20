// Color tokens for Diktat.
//
// Brand: Diktat Violet (#7B2CFF) is the headline mark; electric blue (#6EE7FF)
// is the accent (X header / shield wireframe per docs/X_LAUNCH_PLAN.md §1).
//
// Neutrals are a 12-stop ladder, dark-first: ink.* runs deepest-to-bright,
// paper.* mirrors it on the light end. The app surface lives near ink.0/1000.
//
// Tier ladder (t0..t11) — single source of truth consumed by the TierBadge
// component (next PR). Each tier carries { base, ring, fg, glowFrom, glowTo }:
//
//   t0  Recruit       slate-gray            (cold start)
//   t1  Apprentice    cool slate
//   t2  Acolyte       desaturated cyan
//   t3  Cadet         steel blue
//   t4  Operator      amber                  *dark fg*
//   t5  Strategist    teal-green
//   t6  Vanguard      diktat violet warm-up  (brand alignment)
//   t7  Architect     deep violet
//   t8  Sovereign     magenta-violet
//   t9  Oracle        crimson
//   t10 Mythic        gold                   *dark fg*
//   t11 Holographic   rainbow gradient halo  *dark fg*
//
// WCAG AA: tiers 4 (amber), 10 (gold), 11 (holo) use ink.900 as fg; all
// others use paper.50.

export const brand = {
  primary: '#7B2CFF',
  primaryFg: '#FFFFFF',
  accent: '#6EE7FF',
  accentFg: '#0A0A0F',
} as const;

// 12-stop dark-first neutrals.
// ink.0 is the absolute black surface; ink.1000 is near-white.
export const ink = {
  0: '#0A0A0F',
  50: '#0F0F16',
  100: '#15151F',
  200: '#1C1C28',
  300: '#262633',
  400: '#34343F',
  500: '#454553',
  600: '#5C5C6B',
  700: '#7A7A8C',
  800: '#A0A0B0',
  900: '#CACAD6',
  1000: '#F2F2F7',
} as const;

// paper.* mirrors ink — paper.0 is pure white, paper.1000 is deep ink.
export const paper = {
  0: '#FFFFFF',
  50: '#FAFAFC',
  100: '#F2F2F7',
  200: '#E6E6EE',
  300: '#D5D5E0',
  400: '#B8B8C8',
  500: '#9A9AAE',
  600: '#7A7A8C',
  700: '#5C5C6B',
  800: '#3F3F4D',
  900: '#1F1F2A',
  1000: '#0A0A0F',
} as const;

export const semantic = {
  success: {
    base: '#22C55E',
    fg: '#FFFFFF',
    soft: '#1A3A2A',
    softFg: '#86EFAC',
  },
  danger: {
    base: '#EF4444',
    fg: '#FFFFFF',
    soft: '#3A1A1A',
    softFg: '#FCA5A5',
  },
  warning: {
    base: '#F59E0B',
    fg: '#0A0A0F',
    soft: '#3A2E1A',
    softFg: '#FCD34D',
  },
  info: {
    base: '#6EE7FF',
    fg: '#0A0A0F',
    soft: '#1A2D3A',
    softFg: '#7DD3FC',
  },
} as const;

export const surface = {
  app: '#0A0A0F',
  card: '#15151F',
  raised: '#1C1C28',
  sunken: '#0F0F16',
  overlay: 'rgba(10, 10, 15, 0.72)',
  scrim: 'rgba(0, 0, 0, 0.56)',
} as const;

export const text = {
  primary: '#F2F2F7',
  secondary: '#CACAD6',
  tertiary: '#A0A0B0',
  inverse: '#0A0A0F',
  disabled: '#5C5C6B',
  link: '#6EE7FF',
  linkHover: '#A5F0FF',
} as const;

// Tier ladder — see header comment above for the design rationale.
export const tier = {
  t0: {
    base: '#6B7280',
    ring: '#9CA3AF',
    fg: '#FAFAFC',
    glowFrom: '#6B7280',
    glowTo: '#4B5563',
  },
  t1: {
    base: '#64748B',
    ring: '#94A3B8',
    fg: '#FAFAFC',
    glowFrom: '#64748B',
    glowTo: '#475569',
  },
  t2: {
    base: '#0EA5E9',
    ring: '#38BDF8',
    fg: '#FAFAFC',
    glowFrom: '#0EA5E9',
    glowTo: '#0369A1',
  },
  t3: {
    base: '#3B82F6',
    ring: '#60A5FA',
    fg: '#FAFAFC',
    glowFrom: '#3B82F6',
    glowTo: '#1D4ED8',
  },
  t4: {
    base: '#F59E0B',
    ring: '#FBBF24',
    fg: '#1F1F2A',
    glowFrom: '#F59E0B',
    glowTo: '#D97706',
  },
  t5: {
    base: '#14B8A6',
    ring: '#2DD4BF',
    fg: '#FAFAFC',
    glowFrom: '#14B8A6',
    glowTo: '#0F766E',
  },
  t6: {
    base: '#7B2CFF',
    ring: '#A78BFA',
    fg: '#FAFAFC',
    glowFrom: '#7B2CFF',
    glowTo: '#6EE7FF',
  },
  t7: {
    base: '#6D28D9',
    ring: '#8B5CF6',
    fg: '#FAFAFC',
    glowFrom: '#7B2CFF',
    glowTo: '#4C1D95',
  },
  t8: {
    base: '#C026D3',
    ring: '#E879F9',
    fg: '#FAFAFC',
    glowFrom: '#C026D3',
    glowTo: '#7B2CFF',
  },
  t9: {
    base: '#DC2626',
    ring: '#F87171',
    fg: '#FAFAFC',
    glowFrom: '#DC2626',
    glowTo: '#7F1D1D',
  },
  t10: {
    base: '#FACC15',
    ring: '#FDE047',
    fg: '#1F1F2A',
    glowFrom: '#FACC15',
    glowTo: '#CA8A04',
  },
  t11: {
    base: '#F0F0F8',
    ring: '#FFFFFF',
    fg: '#1F1F2A',
    glowFrom: '#7B2CFF',
    glowTo: '#6EE7FF',
  },
} as const;

export const colors = {
  brand,
  ink,
  paper,
  semantic,
  surface,
  text,
  tier,
} as const;

export type Colors = typeof colors;
