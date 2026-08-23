import type {
  FailedPayment,
  FailureReason,
  RecoveryAction,
  RecoveryActionKind,
  RiskTier,
  Signal,
} from '@/domain';

/**
 * Deterministic scoring and action selection.
 *
 * This is a faithful mirror of `src-tauri/src/recovery/rules.rs`, which is the
 * authoritative implementation once the Rust engine is wired up. It exists in
 * TypeScript so the UI has real, explainable recommendations during frontend
 * development instead of hardcoded strings. There is no model call here and
 * nothing is randomised: same input, same recommendation, always.
 *
 * Keep the two files in step. The Rust tests in `rules.rs` cover the same
 * cases as the table below.
 */

/** Historical recovery rate per failure reason, the prior for the score. */
const BASE_SCORE: Record<FailureReason, number> = {
  gateway_timeout: 0.81,
  bank_downtime: 0.78,
  authentication_timeout: 0.71,
  upi_collect_expired: 0.66,
  insufficient_funds: 0.62,
  do_not_honour: 0.55,
  limit_exceeded: 0.48,
  card_expired: 0.34,
  invalid_card: 0.22,
  mandate_revoked: 0.18,
};

const HIGH_TICKET_PAISE = 25_00_000; // ₹25,000
const CRITICAL_TICKET_PAISE = 50_00_000; // ₹50,000

export interface Scored {
  score: number;
  signals: Signal[];
  riskTier: RiskTier;
}

export function scorePayment(payment: FailedPayment): Scored {
  const base = BASE_SCORE[payment.failureReason];
  const signals: Signal[] = [
    {
      label: 'Failure reason baseline',
      weight: base - 0.5,
      detail: `${Math.round(base * 100)}% of these recover historically`,
    },
  ];

  let score = base;

  if (payment.customer.successfulPayments >= 5) {
    score += 0.08;
    signals.push({
      label: 'Established payer',
      weight: 0.08,
      detail: `${payment.customer.successfulPayments} successful payments before this`,
    });
  } else if (payment.customer.successfulPayments === 0) {
    score -= 0.06;
    signals.push({
      label: 'First payment',
      weight: -0.06,
      detail: 'No payment history to lean on',
    });
  }

  if (payment.attemptCount >= 3) {
    score -= 0.12;
    signals.push({
      label: 'Retry fatigue',
      weight: -0.12,
      detail: `Already attempted ${payment.attemptCount} times`,
    });
  }

  if (payment.amountPaise >= HIGH_TICKET_PAISE) {
    score -= 0.05;
    signals.push({
      label: 'High ticket',
      weight: -0.05,
      detail: 'Large amounts clear less often on retry',
    });
  }

  if (payment.isSubscription) {
    score += 0.05;
    signals.push({
      label: 'Mandate on file',
      weight: 0.05,
      detail: 'Can be re-presented without customer action',
    });
  }

  if (payment.method === 'upi') {
    score += 0.03;
    signals.push({
      label: 'UPI rail',
      weight: 0.03,
      detail: 'UPI re-collects settle faster than card retries',
    });
  }

  score = clamp(score, 0.05, 0.95);
  return { score, signals, riskTier: tierFor(payment, score) };
}

function tierFor(payment: FailedPayment, score: number): RiskTier {
  const value = Math.max(payment.amountPaise, payment.customer.lifetimeValuePaise / 12);
  if (value >= CRITICAL_TICKET_PAISE && score < 0.5) return 'critical';
  if (value >= HIGH_TICKET_PAISE || score < 0.35) return 'high';
  if (value >= 5_00_000) return 'medium';
  return 'low';
}

/**
 * Action selection. Ordered by how much customer effort it costs: re-present
 * silently where we can, ask the customer only when we must, and hand to a
 * human when the engine has no good move.
 */
export function selectAction(payment: FailedPayment, scored: Scored): RecoveryAction {
  const { reason: kind, delayMinutes, label } = decide(payment);
  return {
    kind,
    label,
    channel: CHANNEL_FOR[kind],
    confidence: clamp(scored.score * confidenceFactor(kind), 0.05, 0.97),
    signals: scored.signals,
    delayMinutes,
  };
}

const CHANNEL_FOR: Record<RecoveryActionKind, RecoveryAction['channel']> = {
  auto_retry: 'gateway',
  retry_on_payday: 'gateway',
  retry_after_downtime: 'gateway',
  switch_to_upi: 'whatsapp',
  request_card_update: 'email',
  send_payment_link: 'whatsapp',
  dunning_email: 'email',
  dunning_whatsapp: 'whatsapp',
  human_review: 'in_app',
};

/** Silent re-presentation is more reliable than anything needing a human. */
function confidenceFactor(kind: RecoveryActionKind): number {
  switch (kind) {
    case 'auto_retry':
    case 'retry_after_downtime':
    case 'retry_on_payday':
      return 1;
    case 'send_payment_link':
    case 'switch_to_upi':
      return 0.9;
    case 'request_card_update':
    case 'dunning_email':
    case 'dunning_whatsapp':
      return 0.75;
    case 'human_review':
      return 0.5;
  }
}

interface Decision {
  reason: RecoveryActionKind;
  delayMinutes: number;
  label: string;
}

function decide(payment: FailedPayment): Decision {
  switch (payment.failureReason) {
    case 'gateway_timeout':
      return { reason: 'auto_retry', delayMinutes: 15, label: 'Retry charge in 15 min' };

    case 'bank_downtime':
      return {
        reason: 'retry_after_downtime',
        delayMinutes: 90,
        label: 'Retry once issuer recovers',
      };

    case 'authentication_timeout':
      return { reason: 'send_payment_link', delayMinutes: 5, label: 'Send a fresh payment link' };

    case 'upi_collect_expired':
      return { reason: 'send_payment_link', delayMinutes: 30, label: 'Send a new UPI request' };

    case 'insufficient_funds': {
      const { delayMinutes, target } = paydayPlan(payment.failedAt);
      return {
        reason: 'retry_on_payday',
        delayMinutes,
        label: `Retry on ${dayMonthLabel(target)}`,
      };
    }

    case 'do_not_honour':
      return payment.attemptCount < 2
        ? { reason: 'auto_retry', delayMinutes: 240, label: 'Retry charge in 4 hours' }
        : { reason: 'switch_to_upi', delayMinutes: 0, label: 'Offer UPI instead' };

    case 'limit_exceeded':
      return { reason: 'auto_retry', delayMinutes: 1_440, label: 'Retry charge tomorrow' };

    case 'card_expired':
      return { reason: 'request_card_update', delayMinutes: 0, label: 'Request new card details' };

    case 'invalid_card':
      return payment.isSubscription
        ? { reason: 'request_card_update', delayMinutes: 0, label: 'Request new card details' }
        : { reason: 'send_payment_link', delayMinutes: 0, label: 'Send a fresh payment link' };

    case 'mandate_revoked':
      return { reason: 'human_review', delayMinutes: 0, label: 'Needs a human decision' };
  }
}

/**
 * Salary credits in India cluster on the 1st and, for many employers, the last
 * working day of the month. Retrying insufficient-funds failures into that
 * window is the single highest-yield rule in the engine.
 *
 * Returns the delay and the instant it lands on together, mirroring
 * `payday_plan` in `rules.rs`, so the label and the schedule are derived from
 * one calculation and cannot disagree.
 */
function paydayPlan(failedAt: string): { delayMinutes: number; target: Date } {
  const failed = new Date(failedAt);
  const payday = new Date(failed);
  payday.setUTCHours(6, 30, 0, 0);

  if (failed.getUTCDate() >= 1 && failed.getUTCDate() <= 2) {
    payday.setUTCDate(failed.getUTCDate() + 1);
  } else {
    // Month and day are set in one call so a 31st never overflows into the
    // month after next.
    payday.setUTCMonth(payday.getUTCMonth() + 1, 1);
  }

  const delayMinutes = Math.max(60, Math.round((payday.getTime() - failed.getTime()) / 60_000));
  return { delayMinutes, target: new Date(failed.getTime() + delayMinutes * 60_000) };
}

/** `month_abbreviation` in `src-tauri/src/clock.rs`, not the runtime's locale data. */
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/**
 * Day and abbreviated month in UTC, e.g. `1 Sep`.
 *
 * Deliberately not `Intl.DateTimeFormat('en-IN', { month: 'short' })`, which
 * this used to be, for two reasons. It formats in the *runtime's* timezone while
 * the retry is scheduled in UTC, so anywhere west of UTC-6:30 the label named
 * the day before the one the job actually fires on — the label and the schedule
 * contradicting each other, which is the whole thing `paydayPlan` returning both
 * values is meant to prevent. And current ICU renders September as "Sept" under
 * `en-IN`, so the browser said "1 Sept" where the Rust engine said "1 Sep": the
 * same payment, two different recommendations, depending on which build of which
 * runtime happened to load the page.
 */
function dayMonthLabel(target: Date): string {
  return `${target.getUTCDate()} ${MONTHS[target.getUTCMonth()]}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
