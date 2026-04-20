// Typography tokens. Font families resolve to CSS variables wired up by
// next/font in apps/web/app/layout.tsx (--font-sans / --font-display).

export const fontFamily = {
  sans: 'var(--font-sans), Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  display: 'var(--font-display), var(--font-sans), Inter, system-ui, -apple-system, sans-serif',
  mono: 'ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace',
} as const;

// Mobile-first display scale. Values in rem assuming 16px root.
// Each entry is the Tailwind 2-tuple form `[size, { lineHeight }]`.
export const fontSize: Record<string, [string, { lineHeight: string }]> = {
  xs: ['0.75rem', { lineHeight: '1rem' }], // 12 / 16
  sm: ['0.875rem', { lineHeight: '1.25rem' }], // 14 / 20
  base: ['1rem', { lineHeight: '1.5rem' }], // 16 / 24
  lg: ['1.125rem', { lineHeight: '1.75rem' }], // 18 / 28
  xl: ['1.25rem', { lineHeight: '1.75rem' }], // 20 / 28
  '2xl': ['1.5rem', { lineHeight: '2rem' }], // 24 / 32
  '3xl': ['1.875rem', { lineHeight: '2.25rem' }], // 30 / 36
  '4xl': ['2.25rem', { lineHeight: '2.5rem' }], // 36 / 40
  '5xl': ['3rem', { lineHeight: '1' }], // 48
  '6xl': ['3.75rem', { lineHeight: '1' }], // 60
};

export const fontWeight = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
} as const;

export const lineHeight = {
  tight: '1.1',
  snug: '1.25',
  normal: '1.5',
  relaxed: '1.625',
  loose: '2',
} as const;

export const letterSpacing = {
  tighter: '-0.05em',
  tight: '-0.025em',
  normal: '0em',
  wide: '0.025em',
  wider: '0.05em',
  widest: '0.1em',
} as const;

export const typography = {
  fontFamily,
  fontSize,
  fontWeight,
  lineHeight,
  letterSpacing,
} as const;

export type Typography = typeof typography;
