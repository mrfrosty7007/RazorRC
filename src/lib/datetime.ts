/** All timestamps crossing the IPC boundary are ISO-8601 UTC strings. */

const TIME = new Intl.DateTimeFormat('en-IN', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const DAY = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short' });

const DAY_TIME = new Intl.DateTimeFormat('en-IN', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** Shown wherever a timestamp cannot be read, so a row still renders. */
const UNKNOWN = '—';

/**
 * `Intl.DateTimeFormat.format` throws `RangeError: Invalid time value` on an
 * unparseable date, and these formatters are called deep inside table cells and
 * timelines. One bad row from the gateway would otherwise take down the whole
 * screen, so a value we cannot read degrades to a dash instead.
 */
function safe(iso: string, fmt: Intl.DateTimeFormat): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? UNKNOWN : fmt.format(at);
}

export function formatTime(iso: string): string {
  return safe(iso, TIME);
}

export function formatDay(iso: string): string {
  return safe(iso, DAY);
}

export function formatDayTime(iso: string): string {
  return safe(iso, DAY_TIME);
}

/** `4m ago`, `3h ago`, `2d ago`, and `in 22m` for scheduled retries. */
export function formatRelative(iso: string, now: Date = new Date()): string {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return UNKNOWN;

  const deltaMs = at - now.getTime();
  const future = deltaMs > 0;
  const mins = Math.round(Math.abs(deltaMs) / 60_000);

  if (mins < 1) return 'just now';
  const label =
    mins < 60
      ? `${mins}m`
      : mins < 60 * 24
        ? `${Math.round(mins / 60)}h`
        : `${Math.round(mins / (60 * 24))}d`;

  return future ? `in ${label}` : `${label} ago`;
}

/**
 * Mirrors `clock::iso_days_ago` in Rust, which subtracts a `f64` number of days
 * as an exact duration. Fractional days matter: the seed fixtures space a
 * retry ladder 0.35 days apart, and the earlier `setUTCDate` form silently
 * truncated its argument to an integer, collapsing every rung of the ladder
 * onto the same instant. Whole-day callers are unaffected — UTC has no DST, so
 * subtracting 86,400,000 ms is the same calendar arithmetic.
 */
export function isoDaysAgo(days: number, from: Date = new Date()): string {
  return new Date(from.getTime() - days * 86_400_000).toISOString();
}

export function isoMinutesFromNow(minutes: number, from: Date = new Date()): string {
  return new Date(from.getTime() + minutes * 60_000).toISOString();
}
