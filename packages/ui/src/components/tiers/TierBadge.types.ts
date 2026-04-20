// Public type surface for the TierBadge component.

export type TierNumber = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;

export type TierSize = 'sm' | 'md' | 'lg' | 'xl';

/** Pixel diameter for each named size. */
export const TIER_SIZE_PX: Record<TierSize, number> = {
  sm: 24,
  md: 40,
  lg: 64,
  xl: 96,
};

export interface TierBadgeProps {
  tier: TierNumber;
  size?: TierSize;
  /** Render the soft halo glow. Disabled under prefers-reduced-motion. */
  glow?: boolean;
  /** Render in a desaturated/locked state with `aria-disabled`. */
  locked?: boolean;
  /** Show the tier name beside the badge. */
  showLabel?: boolean;
  /** Override the auto-generated aria-label. */
  ariaLabel?: string;
  className?: string;
}
