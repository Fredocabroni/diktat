// Motion tokens.
//
// `duration.tierUp` is a 4-element tuple — one entry per severity level of
// tier-up celebration (per docs/ADDICTION_ARCHITECTURE.md §7). Severity 1 is
// a quick chip flip; severity 4 is a full ritual reserved for tier 10+.

export const duration = {
  instant: 100,
  fast: 200,
  normal: 300,
  slow: 500,
  ritual: 800,
  tierUp: [600, 900, 1200, 1600] as const,
} as const;

export const easing = {
  standard: 'cubic-bezier(0.2, 0, 0, 1)',
  decelerate: 'cubic-bezier(0, 0, 0.2, 1)',
  accelerate: 'cubic-bezier(0.4, 0, 1, 1)',
  emphasized: 'cubic-bezier(0.2, 0, 0, 1.2)',
} as const;

export const motion = {
  duration,
  easing,
} as const;

export type Motion = typeof motion;
