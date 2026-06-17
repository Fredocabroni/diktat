// Live countdown to the next 8 PM ET Drop. Mounted in the pre-Drop
// and empty states; never visible during the live state.

'use client';

import { useEffect, useState } from 'react';

import { formatCountdown, nextDropAtEt } from '../../lib/drop-time';

interface NextDropCountdownProps {
  readonly className?: string;
}

export function NextDropCountdown({ className }: NextDropCountdownProps): React.JSX.Element {
  const [now, setNow] = useState<Date>(() => new Date());

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(id);
  }, []);

  const target = nextDropAtEt(now);
  const countdown = formatCountdown(Date.parse(target), now.getTime());

  return (
    <p
      data-component="NextDropCountdown"
      className={`text-center text-xs uppercase tracking-wide text-text-tertiary ${className ?? ''}`}
    >
      Next Drop · 8 PM ET · <span className="font-mono">{countdown}</span>
    </p>
  );
}
