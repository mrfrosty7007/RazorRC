/**
 * Formatting helpers. Amounts are held as integer paise everywhere in the
 * app -- the same unit the Razorpay API uses -- so no float arithmetic ever
 * touches a rupee figure.
 */

const INR = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

const INR_PRECISE = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Stand-in for a figure we cannot render. A merchant console that prints
 * `₹NaN` or `NaN%` next to real money destroys trust in every other number on
 * the screen, so anything non-finite — a malformed IPC payload, a divide by
 * zero — degrades to a dash instead.
 */
const UNKNOWN = '—';

export function paiseToRupees(paise: number): number {
  return paise / 100;
}

/** `₹1,24,500` -- full precision, Indian digit grouping. */
export function formatINR(paise: number): string {
  if (!Number.isFinite(paise)) return UNKNOWN;
  return INR.format(paiseToRupees(paise));
}

/** `₹1,245.00` -- for single-transaction amounts where paise matter. */
export function formatINRExact(paise: number): string {
  if (!Number.isFinite(paise)) return UNKNOWN;
  return INR_PRECISE.format(paiseToRupees(paise));
}

/**
 * `₹12.4L`, `₹3.2Cr` -- lakh/crore shorthand, which is how Indian finance
 * teams actually read these numbers. Used in KPI tiles and axis labels.
 */
export function formatINRCompact(paise: number): string {
  if (!Number.isFinite(paise)) return UNKNOWN;

  const rupees = paiseToRupees(paise);
  const abs = Math.abs(rupees);
  const sign = rupees < 0 ? '-' : '';

  if (abs >= 1_00_00_000) return `${sign}₹${trim(abs / 1_00_00_000)}Cr`;
  if (abs >= 1_00_000) return `${sign}₹${trim(abs / 1_00_000)}L`;
  if (abs >= 1_000) return `${sign}₹${trim(abs / 1_000)}K`;
  return `${sign}₹${Math.round(abs)}`;
}

function trim(value: number): string {
  return value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2).replace(/\.0+$/, '');
}

export function formatPercent(fraction: number, digits = 1): string {
  if (!Number.isFinite(fraction)) return UNKNOWN;
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return UNKNOWN;
  return new Intl.NumberFormat('en-IN').format(value);
}

/** Signed delta for trend chips: `+4.2pp`, `-1.0pp`. */
export function formatPointDelta(fraction: number, digits = 1): string {
  if (!Number.isFinite(fraction)) return UNKNOWN;
  const pp = fraction * 100;
  return `${pp >= 0 ? '+' : ''}${pp.toFixed(digits)}pp`;
}

export function formatSignedPercent(fraction: number, digits = 1): string {
  if (!Number.isFinite(fraction)) return UNKNOWN;
  const pct = fraction * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(digits)}%`;
}
