// Shadow tokens. Standard elevation + brand glows.
//
// `glow.violet` and `glow.gold` are single-color halos used by the brand
// surfaces and tier-10 badge respectively. `glow.holo` layers violet + cyan +
// magenta to mimic the holographic shield seen on tier 11 (Mythic+).

export const shadows = {
  xs: '0 1px 2px 0 rgba(0, 0, 0, 0.40)',
  sm: '0 1px 3px 0 rgba(0, 0, 0, 0.45), 0 1px 2px -1px rgba(0, 0, 0, 0.40)',
  md: '0 4px 6px -1px rgba(0, 0, 0, 0.50), 0 2px 4px -2px rgba(0, 0, 0, 0.40)',
  lg: '0 10px 15px -3px rgba(0, 0, 0, 0.55), 0 4px 6px -4px rgba(0, 0, 0, 0.45)',
  xl: '0 20px 25px -5px rgba(0, 0, 0, 0.60), 0 8px 10px -6px rgba(0, 0, 0, 0.50)',
  glow: {
    violet:
      '0 0 0 1px rgba(123, 44, 255, 0.45), 0 0 24px 4px rgba(123, 44, 255, 0.55)',
    gold:
      '0 0 0 1px rgba(250, 204, 21, 0.55), 0 0 28px 6px rgba(250, 204, 21, 0.45)',
    holo:
      '0 0 0 1px rgba(255, 255, 255, 0.35), 0 0 18px 2px rgba(123, 44, 255, 0.55), 0 0 28px 6px rgba(110, 231, 255, 0.45), 0 0 36px 8px rgba(232, 121, 249, 0.40)',
  },
} as const;

export type Shadows = typeof shadows;
