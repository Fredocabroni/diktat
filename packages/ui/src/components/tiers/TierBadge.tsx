import * as React from 'react';

import { tier as tierTokens } from '../../tokens/colors.js';
import { EMBLEMS } from './emblems/index.js';
import { TIER_SIZE_PX, type TierBadgeProps } from './TierBadge.types.js';
import { TIERS, tierByNumber } from './tiers.config.js';

/**
 * Hook that respects `prefers-reduced-motion`. Returns `true` when the user
 * has asked the OS to minimize motion. Defaults to `false` on the server.
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });
  React.useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return reduced;
}

function defaultAriaLabel(name: string, ap: number, locked: boolean): string {
  const base = `${name} tier, ${ap.toLocaleString('en-US')} arena points`;
  return locked ? `${base} (locked)` : base;
}

/**
 * 12-tier badge — pure visual primitive. Renders a circular emblem in the
 * tier palette, with optional name label, halo glow, and locked state.
 *
 * Sizes: sm 24px (decorative-only — never use as a sole click target),
 * md 40px, lg 64px, xl 96px.
 *
 * Accessibility:
 *   - role="img" with auto aria-label "{Name} tier, {AP} arena points"
 *   - locked=true sets aria-disabled="true"
 *   - glow + Mythic gradient gated by prefers-reduced-motion
 */
export function TierBadge(props: TierBadgeProps): React.ReactElement {
  const {
    tier: tierNumber,
    size = 'md',
    glow = false,
    locked = false,
    showLabel = false,
    ariaLabel,
    className,
  } = props;

  const reduced = usePrefersReducedMotion();
  const config = tierByNumber(tierNumber);
  const palette = tierTokens[config.paletteKey];
  const Emblem = EMBLEMS[config.emblemId];
  const px = TIER_SIZE_PX[size];

  const showGlow = glow && !reduced;
  const isMythic = config.paletteKey === 't11';
  const animateMythic = isMythic && !reduced;

  const badgeStyle: React.CSSProperties = {
    width: px,
    height: px,
    borderRadius: '9999px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: animateMythic
      ? `conic-gradient(from var(--tier-hue, 0deg), ${palette.glowFrom}, ${palette.glowTo}, ${palette.glowFrom})`
      : palette.base,
    color: palette.fg,
    border: `2px solid ${palette.ring}`,
    boxShadow: showGlow
      ? `0 0 ${Math.round(px / 4)}px ${palette.glowFrom}, 0 0 ${Math.round(px / 2)}px ${palette.glowTo}`
      : 'none',
    opacity: locked ? 0.45 : 1,
    filter: locked ? 'grayscale(0.7)' : 'none',
    flexShrink: 0,
    transition: 'box-shadow 200ms ease-out, opacity 150ms ease-out',
  };

  const innerPaddingPx = Math.max(2, Math.round(px * 0.18));

  const containerStyle: React.CSSProperties = showLabel
    ? { display: 'inline-flex', alignItems: 'center', gap: Math.round(px * 0.25) }
    : { display: 'inline-block' };

  const label = ariaLabel ?? defaultAriaLabel(config.name, config.apThreshold, locked);

  const labelEl = showLabel ? (
    <span
      style={{
        fontFamily: 'var(--font-display, var(--font-sans, system-ui))',
        fontWeight: 600,
        fontSize: Math.max(12, Math.round(px * 0.32)),
        color: 'var(--color-text-primary, #f2f2f7)',
      }}
    >
      {config.name}
    </span>
  ) : null;

  return (
    <span
      role="img"
      aria-label={label}
      aria-disabled={locked || undefined}
      data-tier={tierNumber}
      data-size={size}
      data-locked={locked || undefined}
      data-glow={showGlow || undefined}
      data-mythic={isMythic || undefined}
      className={className}
      style={containerStyle}
    >
      <span style={badgeStyle} aria-hidden>
        <span
          style={{
            width: px - innerPaddingPx * 2,
            height: px - innerPaddingPx * 2,
            display: 'inline-flex',
            color: palette.fg,
          }}
        >
          <Emblem />
        </span>
      </span>
      {labelEl}
    </span>
  );
}

/** Re-export the 12-entry config so consumers can iterate without re-importing. */
export { TIERS };
