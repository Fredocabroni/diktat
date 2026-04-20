// Barrel export for all design tokens. The `tokens` const is the canonical
// runtime entry; the named re-exports exist so a consumer can pull a slice
// without dragging the whole graph in.

export {
  brand,
  ink,
  paper,
  semantic,
  surface,
  text,
  tier,
  colors,
} from './colors.js';
export {
  fontFamily,
  fontSize,
  fontWeight,
  lineHeight,
  letterSpacing,
  typography,
} from './typography.js';
export { spacing } from './spacing.js';
export { radii } from './radii.js';
export { shadows } from './shadows.js';
export { duration, easing, motion } from './motion.js';
export { breakpoints } from './breakpoints.js';
export { z } from './z.js';

export type { Colors } from './colors.js';
export type { Typography } from './typography.js';
export type { Spacing } from './spacing.js';
export type { Radii } from './radii.js';
export type { Shadows } from './shadows.js';
export type { Motion } from './motion.js';
export type { Breakpoints } from './breakpoints.js';
export type { Z } from './z.js';

import { colors } from './colors.js';
import { typography } from './typography.js';
import { spacing } from './spacing.js';
import { radii } from './radii.js';
import { shadows } from './shadows.js';
import { motion } from './motion.js';
import { breakpoints } from './breakpoints.js';
import { z } from './z.js';

export const tokens = {
  colors,
  typography,
  spacing,
  radii,
  shadows,
  motion,
  breakpoints,
  z,
} as const;

export type Tokens = typeof tokens;
