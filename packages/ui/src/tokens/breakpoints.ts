// Breakpoint tokens, mobile-first. Pixel values map directly to Tailwind's
// `screens` config.

export const breakpoints = {
  sm: '640px',
  md: '768px',
  lg: '1024px',
  xl: '1280px',
  '2xl': '1536px',
} as const;

export type Breakpoints = typeof breakpoints;
