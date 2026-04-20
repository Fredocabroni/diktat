// Tailwind v3 preset that maps Diktat design tokens onto Tailwind's theme.
// Consumed by both packages/ui (Storybook) and apps/web. Token values are
// imported directly so there is exactly one source of truth.

import type { Config } from 'tailwindcss';

import { brand, ink, paper, semantic, surface, text, tier } from './tokens/colors.js';
import {
  fontFamily,
  fontSize,
  fontWeight,
  letterSpacing,
  lineHeight,
} from './tokens/typography.js';
import { spacing } from './tokens/spacing.js';
import { radii } from './tokens/radii.js';
import { shadows } from './tokens/shadows.js';
import { duration, easing } from './tokens/motion.js';
import { breakpoints } from './tokens/breakpoints.js';
import { z } from './tokens/z.js';

const tierColors = Object.fromEntries(
  Object.entries(tier).map(([key, value]) => [key, value.base]),
);

const tierRingColors = Object.fromEntries(
  Object.entries(tier).map(([key, value]) => [key, value.ring]),
);

const tierFgColors = Object.fromEntries(
  Object.entries(tier).map(([key, value]) => [key, value.fg]),
);

const tierGlowFromColors = Object.fromEntries(
  Object.entries(tier).map(([key, value]) => [`${key}-from`, value.glowFrom]),
);

const tierGlowToColors = Object.fromEntries(
  Object.entries(tier).map(([key, value]) => [`${key}-to`, value.glowTo]),
);

export const diktatPreset: Config = {
  // The preset itself does not scan content — consumers (apps/web,
  // packages/ui) provide their own `content` globs.
  content: [],
  darkMode: 'class',
  theme: {
    screens: {
      sm: breakpoints.sm,
      md: breakpoints.md,
      lg: breakpoints.lg,
      xl: breakpoints.xl,
      '2xl': breakpoints['2xl'],
    },
    extend: {
      colors: {
        brand: {
          DEFAULT: brand.primary,
          fg: brand.primaryFg,
          accent: brand.accent,
          'accent-fg': brand.accentFg,
        },
        ink,
        paper,
        success: {
          DEFAULT: semantic.success.base,
          fg: semantic.success.fg,
          soft: semantic.success.soft,
          'soft-fg': semantic.success.softFg,
        },
        danger: {
          DEFAULT: semantic.danger.base,
          fg: semantic.danger.fg,
          soft: semantic.danger.soft,
          'soft-fg': semantic.danger.softFg,
        },
        warning: {
          DEFAULT: semantic.warning.base,
          fg: semantic.warning.fg,
          soft: semantic.warning.soft,
          'soft-fg': semantic.warning.softFg,
        },
        info: {
          DEFAULT: semantic.info.base,
          fg: semantic.info.fg,
          soft: semantic.info.soft,
          'soft-fg': semantic.info.softFg,
        },
        surface,
        text,
        tier: {
          ...tierColors,
          ring: tierRingColors,
          fg: tierFgColors,
          glow: { ...tierGlowFromColors, ...tierGlowToColors },
        },
      },
      fontFamily: {
        sans: [fontFamily.sans],
        display: [fontFamily.display],
        mono: [fontFamily.mono],
      },
      fontSize,
      fontWeight: {
        regular: fontWeight.regular,
        medium: fontWeight.medium,
        semibold: fontWeight.semibold,
        bold: fontWeight.bold,
      },
      lineHeight,
      letterSpacing,
      spacing,
      borderRadius: radii,
      boxShadow: {
        xs: shadows.xs,
        sm: shadows.sm,
        md: shadows.md,
        lg: shadows.lg,
        xl: shadows.xl,
        'glow-violet': shadows.glow.violet,
        'glow-gold': shadows.glow.gold,
        'glow-holo': shadows.glow.holo,
      },
      transitionDuration: {
        instant: `${duration.instant}ms`,
        fast: `${duration.fast}ms`,
        normal: `${duration.normal}ms`,
        slow: `${duration.slow}ms`,
        ritual: `${duration.ritual}ms`,
        'tier-up-1': `${duration.tierUp[0]}ms`,
        'tier-up-2': `${duration.tierUp[1]}ms`,
        'tier-up-3': `${duration.tierUp[2]}ms`,
        'tier-up-4': `${duration.tierUp[3]}ms`,
      },
      transitionTimingFunction: {
        standard: easing.standard,
        decelerate: easing.decelerate,
        accelerate: easing.accelerate,
        emphasized: easing.emphasized,
      },
      zIndex: Object.fromEntries(Object.entries(z).map(([k, v]) => [k, String(v)])),
    },
  },
};

export default diktatPreset;
