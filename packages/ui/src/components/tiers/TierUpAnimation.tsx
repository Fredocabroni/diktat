import { LazyMotion, domAnimation, m, useReducedMotion } from 'framer-motion';
import * as React from 'react';

import { tier as tierColors } from '../../tokens/colors.js';
import { duration as motionDuration } from '../../tokens/motion.js';
import { TierBadge } from './TierBadge.js';
import type { TierNumber } from './TierBadge.types.js';
import { type TierUpSeverity } from './tierUpSeverity.js';

export type { TierUpSeverity } from './tierUpSeverity.js';

export interface TierUpAnimationProps {
  fromTier: TierNumber;
  toTier: TierNumber;
  severity: TierUpSeverity;
  onComplete?: () => void;
}

const PARTICLE_COUNTS: Record<TierUpSeverity, number> = {
  1: 12,
  2: 24,
  3: 48,
  4: 96,
};

// Motion tokens as Framer cubic-bezier tuples (Framer's `ease` wants an array,
// not the CSS `cubic-bezier(...)` string form the tokens store).
const EASE_STANDARD = [0.2, 0, 0, 1] as const; // mirrors easing.standard
const EASE_EMPHASIZED = [0.2, 0, 0, 1.2] as const; // mirrors easing.emphasized (overshoot)

/**
 * Deterministic particle field for a burst. Angles are evenly spaced by index
 * (no Math.random — banned in this workspace and it keeps the burst testable
 * + identical across renders). Radius/size vary by a cheap index hash so the
 * ring doesn't look mechanical.
 */
function useParticles(count: number, toTier: TierNumber) {
  return React.useMemo(() => {
    const glowFrom = tierColors[`t${toTier}` as keyof typeof tierColors].glowFrom;
    const glowTo = tierColors[`t${toTier}` as keyof typeof tierColors].glowTo;
    return Array.from({ length: count }, (_, i) => {
      const angle = (i / count) * Math.PI * 2;
      const jitter = ((i * 47) % 13) / 13; // 0..1, deterministic
      const radius = 60 + jitter * 60; // 60..120px
      return {
        id: i,
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        size: 4 + ((i * 31) % 5), // 4..8px
        color: i % 2 === 0 ? glowFrom : glowTo,
        delay: (i % 6) * 0.015, // slight stagger
      };
    });
  }, [count, toTier]);
}

/**
 * Tier-up celebration. Pure visual + non-coercive — no countdown, no
 * push-prompt, no "tap to claim" gate. The animation runs once and calls
 * `onComplete`; the consumer decides what happens after.
 *
 * Severity 1..4 maps to motion.duration.tierUp[severity-1] and a graded
 * particle count (12/24/48/96). Reduced-motion users see a static badge
 * crossfade with no particles and `onComplete` fires immediately.
 *
 * Rendering: uses Framer Motion's lightweight `m.*` components. A `LazyMotion`
 * ancestor must supply the animation features — the host app provides one
 * (apps/web providers), and this component self-wraps in `LazyMotion` as a
 * fallback so it also animates in isolation (Storybook / standalone). Nested
 * LazyMotion providers are harmless: the inner one just re-supplies the same
 * `domAnimation` feature bundle.
 *
 * Audited by addiction-auditor: no FOMO, no streak coercion, no
 * variable-reward schedule.
 */
export function TierUpAnimation(props: TierUpAnimationProps): React.ReactElement {
  return (
    <LazyMotion features={domAnimation}>
      <TierUpAnimationInner {...props} />
    </LazyMotion>
  );
}

function TierUpAnimationInner({
  fromTier,
  toTier,
  severity,
  onComplete,
}: TierUpAnimationProps): React.ReactElement {
  const reduced = useReducedMotion();
  // severity is 1..4 so severity-1 is always a valid tuple index; the `??`
  // only satisfies noUncheckedIndexedAccess (tierUp[0] is a known number).
  const ms = motionDuration.tierUp[severity - 1] ?? motionDuration.tierUp[0];
  const particleCount = reduced ? 0 : PARTICLE_COUNTS[severity];
  const particles = useParticles(particleCount, toTier);

  React.useEffect(() => {
    if (reduced) {
      onComplete?.();
      return;
    }
    const id = window.setTimeout(() => onComplete?.(), ms);
    return () => window.clearTimeout(id);
  }, [reduced, ms, onComplete]);

  return (
    <div
      role="status"
      aria-live="polite"
      data-severity={severity}
      data-reduced-motion={reduced || undefined}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 16,
        position: 'relative',
        padding: 12,
      }}
    >
      <m.span
        initial={reduced ? false : { opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: motionDuration.fast / 1000, ease: EASE_STANDARD }}
        style={{ display: 'inline-flex' }}
      >
        <TierBadge tier={fromTier} size="lg" />
      </m.span>

      <m.span
        aria-hidden
        initial={reduced ? false : { opacity: 0 }}
        animate={{ opacity: 0.7 }}
        transition={{ duration: motionDuration.fast / 1000, delay: 0.05 }}
        style={{
          fontFamily: 'var(--font-display, system-ui)',
          fontSize: 24,
          color: 'var(--color-text-secondary, #cacad6)',
        }}
      >
        →
      </m.span>

      {/* Destination badge: springs in, then the particle burst emanates from it. */}
      <span style={{ position: 'relative', display: 'inline-flex' }}>
        <m.span
          initial={reduced ? false : { opacity: 0, scale: 0.6 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{
            delay: reduced ? 0 : 0.12,
            duration: motionDuration.normal / 1000,
            ease: EASE_EMPHASIZED,
          }}
          style={{ display: 'inline-flex' }}
        >
          <TierBadge tier={toTier} size="lg" glow={!reduced} />
        </m.span>

        {!reduced &&
          particles.map((p) => (
            <m.span
              key={p.id}
              aria-hidden
              data-particle
              initial={{ opacity: 0, x: 0, y: 0, scale: 0.5 }}
              animate={{ opacity: [0, 1, 0], x: p.x, y: p.y, scale: 1 }}
              transition={{
                delay: 0.18 + p.delay,
                duration: ms / 1000,
                ease: EASE_STANDARD,
              }}
              style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                width: p.size,
                height: p.size,
                marginTop: -p.size / 2,
                marginLeft: -p.size / 2,
                borderRadius: '9999px',
                backgroundColor: p.color,
                pointerEvents: 'none',
              }}
            />
          ))}
      </span>
    </div>
  );
}
