// ET-boundary helpers for the Drop UI.
//
// The 8 PM ET anchor (ADDICTION §5: "Never move The Drop time") is owned
// by the workers' `drop_publish` handler (`drop-publish.ts:202` —
// `todayDropAtEt`). The handler stamps `news_topics.drop_at` at insert
// time; the UI just reads that value and computes display state against
// the current wall-clock. These helpers exist to:
//
//   - Compute the next 20:00 ET instant so the "Next Drop · 8 PM ET"
//     countdown has a target.
//   - Decide whether a row's `drop_at` belongs to today's ET calendar
//     day (live state) or earlier (pre-Drop fallback).
//
// DST handling mirrors the workers' approach: round-trip through Intl
// to find the offset for the specific ET wall-clock moment, then build
// a UTC ISO.

const DROP_HOUR_ET = 20; // 8 PM ET

interface EtParts {
  readonly year: string;
  readonly month: string;
  readonly day: string;
}

const ET_DATE_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Returns the ET calendar-date parts (YYYY, MM, DD) for an instant. */
function etPartsForInstant(instant: Date): EtParts {
  const parts = ET_DATE_FORMAT.formatToParts(instant);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  return { year: get('year'), month: get('month'), day: get('day') };
}

/** Offset (in ms) from UTC for America/New_York at a given ET wall-clock
 *  moment. DST-correct via Intl. Mirrors `drop-publish.ts:228`. */
function etOffsetMsAt(etWallClockIso: string): number {
  const utcAsIfEt = new Date(`${etWallClockIso}Z`);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(utcAsIfEt);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  let hour = get('hour');
  if (hour === '24') hour = '00';
  const reflected = Date.parse(
    `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}:${get('second')}Z`,
  );
  return reflected - utcAsIfEt.getTime();
}

/** ISO string for `YYYY-MM-DDT20:00:00 ET` for the given ET parts. */
function dropAtIsoFor(parts: EtParts): string {
  const local = `${parts.year}-${parts.month}-${parts.day}T${String(DROP_HOUR_ET).padStart(2, '0')}:00:00`;
  const offset = etOffsetMsAt(local);
  return new Date(Date.parse(`${local}Z`) - offset).toISOString();
}

/** Today's 20:00 ET as an ISO string. */
export function todayDropAtEt(now: Date): string {
  return dropAtIsoFor(etPartsForInstant(now));
}

/** The next 20:00 ET instant after `now`. If today's 20:00 ET hasn't
 *  arrived yet, returns today's; otherwise tomorrow's. */
export function nextDropAtEt(now: Date): string {
  const todayDrop = todayDropAtEt(now);
  if (Date.parse(todayDrop) > now.getTime()) return todayDrop;
  // Roll the ET calendar date forward by one day. Add 24h to the
  // computed today's 20:00 ET and round-trip through the ET formatter
  // to get tomorrow's ET-day parts.
  const tomorrow = new Date(Date.parse(todayDrop) + 24 * 60 * 60 * 1000);
  return dropAtIsoFor(etPartsForInstant(tomorrow));
}

/** True when `dropAt`'s ET calendar date is the same as `now`'s ET
 *  calendar date AND `dropAt` has already passed. The pipeline only
 *  produces one row per ET day, so this is "today's live Drop." */
export function isLiveDrop(dropAtIso: string, now: Date): boolean {
  if (Date.parse(dropAtIso) > now.getTime()) return false;
  const todayParts = etPartsForInstant(now);
  const dropParts = etPartsForInstant(new Date(dropAtIso));
  return (
    todayParts.year === dropParts.year &&
    todayParts.month === dropParts.month &&
    todayParts.day === dropParts.day
  );
}

/** Format a forward-looking countdown into "Xh Ym" / "Ym Zs" / "now". */
export function formatCountdown(targetMs: number, nowMs: number): string {
  const deltaSec = Math.max(0, Math.floor((targetMs - nowMs) / 1000));
  if (deltaSec === 0) return 'now';
  const hours = Math.floor(deltaSec / 3600);
  const minutes = Math.floor((deltaSec % 3600) / 60);
  const seconds = deltaSec % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
