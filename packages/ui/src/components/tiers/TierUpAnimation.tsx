import * as React from 'react';

import { duration as motionDuration } from '../../tokens/motion.js';
import { TierBadge } from './TierBadge.js';
import type { TierNumber } from './TierBadge.types.js';

export type TierUpSeverity = 1 | 2 | 3 | 4;

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

/**
 * Tier-up celebration. Pure visual + non-coercive — no countdown, no
 * push-prompt, no "tap to claim" gate. The animation runs once and calls
 * `onComplete`; the consumer decides what happens after (e.g. dismiss
 * modal, route to wallet history).
 *
 * Severity 1..4 maps to motion.duration.tierUp[severity-1] and a
 * monotonically increasing particle count. Reduced-motion users see a
 * static crossfade and onComplete fires immediately.
 *
 * Audited by addiction-auditor: no FOMO, no streak coercion, no
 * variable-reward schedule.
 */
export function TierUpAnimation(props: TierUpAnimationProps): React.ReactElement {
  const { fromTier, toTier, severity, onComplete } = props;
  const reduced = usePrefersReducedMotion();
  const ms = motionDuration.tierUp[severity - 1];
  const particles = PARTICLE_COUNTS[severity];

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
      <TierBadge tier={fromTier} size="lg" />
      <span
        aria-hidden
        style={{
          fontFamily: 'var(--font-display, system-ui)',
          fontSize: 24,
          color: 'var(--color-text-secondary, #cacad6)',
          opacity: 0.7,
        }}
      >
        →
      </span>
      <TierBadge tier={toTier} size="lg" glow={!reduced} />
      <span aria-hidden data-particle-count={particles} style={{ display: 'none' }} />
    </div>
  );
}
