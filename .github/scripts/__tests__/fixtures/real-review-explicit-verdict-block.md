# Addiction Audit

## Per-mechanic verdicts

- `apps/workers/src/jobs/risk-push.ts:22` — risk push every 15 min — verdict: APPROVE — within §12 budget.
- `apps/web/components/battle/BattleTickCountdown.tsx:14` — countdown ticker driven by requestAnimationFrame — verdict: BLOCK — introduces a continuous visual stimulus during loss states (§11 anti-pattern #4).

## Overall verdict: BLOCK

Rewrite the countdown as a once-per-second interval that pauses at 0 instead of a 60fps rAF loop. The §11 anti-pattern test fails as written.
