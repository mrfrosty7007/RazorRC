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

export function formatTime(iso: string): string {
  return TIME.format(new Date(iso));
}

export function formatDay(iso: string): string {
  return DAY.format(new Date(iso));
}

export function formatDayTime(iso: string): string {
  return DAY_TIME.format(new Date(iso));
}

/** `4m ago`, `3h ago`, `2d ago`, and `in 22m` for scheduled retries. */
export function formatRelative(iso: string, now: Date = new Date()): string {
  const deltaMs = new Date(iso).getTime() - now.getTime();
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

export function isoDaysAgo(days: number, from: Date = new Date()): string {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

export function isoMinutesFromNow(minutes: number, from: Date = new Date()): string {
  return new Date(from.getTime() + minutes * 60_000).toISOString();
}
