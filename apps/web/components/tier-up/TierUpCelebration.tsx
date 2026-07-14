'use client';

// Shared, app-level tier-up celebration. Mounted once in the (app) shell, it
// covers every settle surface (trivia, open debate, and any future one) via a
// single detection path — no per-result-screen wiring.
//
// Non-coercive by contract (addiction-auditor): transient (auto-dismisses when
// the animation completes), tap-anywhere to dismiss, no "claim" gate, no
// countdown, no urgency copy, and demotions never show anything. Reduced-motion
// users get the static badge crossfade + immediate dismiss (TierUpAnimation).

import { TierUpAnimation, tierByNumber } from '@diktat/ui';

import { useTierUpDetector } from './useTierUpDetector';

export function TierUpCelebration(): React.JSX.Element | null {
  const { pending, dismiss } = useTierUpDetector();
  if (pending === null) return null;

  const toName = tierByNumber(pending.toTier)?.name ?? '';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Tier up: ${toName}`}
      onClick={dismiss}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 bg-surface-scrim px-6 backdrop-blur-sm"
    >
      <TierUpAnimation
        fromTier={pending.fromTier}
        toTier={pending.toTier}
        severity={pending.severity}
        onComplete={dismiss}
      />
      <p className="text-center font-display text-2xl font-bold text-text-primary">
        You reached {toName}.
      </p>
      <p className="text-sm text-text-tertiary">Tap to continue</p>
    </div>
  );
}
