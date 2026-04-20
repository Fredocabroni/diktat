// One AP-transaction line. Shown in the wallet tx feed. Keeps this
// component presentational so the list can swap for a virtualized
// implementation later without rewriting the row.

const REASON_LABELS: Record<string, string> = {
  battle_win: 'Battle win',
  battle_loss: 'Battle loss',
  predict_win: 'Prediction payout',
  predict_loss: 'Prediction loss',
  daily_streak: 'Daily streak',
  referral: 'Referral',
  ghost_credit: 'Ghost credit',
  tier_bonus: 'Tier bonus',
  admin_adjust: 'Adjustment',
};

function relativeTime(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diffMin = Math.round((now - then) / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.round(diffHour / 24);
  return `${diffDay}d ago`;
}

export interface TransactionRowProps {
  id: string;
  delta: number;
  balanceAfter: number;
  reason: string;
  createdAt: string;
}

export function TransactionRow(props: TransactionRowProps) {
  const label = REASON_LABELS[props.reason] ?? props.reason;
  const positive = props.delta >= 0;
  return (
    <li className="flex items-center justify-between gap-4 rounded-xl bg-surface-elevated px-4 py-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-text-primary">{label}</p>
        <p className="text-xs text-text-tertiary">{relativeTime(props.createdAt)}</p>
      </div>
      <div className="text-right">
        <p
          className={`font-display text-base font-bold ${positive ? 'text-accent-success' : 'text-accent-danger'}`}
        >
          {positive ? '+' : ''}
          {props.delta} AP
        </p>
        <p className="text-xs text-text-tertiary">Balance {props.balanceAfter}</p>
      </div>
    </li>
  );
}
