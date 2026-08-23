import type {
  AttemptEffectiveness,
  AuditEvent,
  AuditSeverity,
  CustomerRef,
  DashboardMetrics,
  EngineStatus,
  FailedPayment,
  FailureBreakdown,
  FailureReason,
  FunnelSegment,
  FunnelStage,
  Insight,
  Merchant,
  MethodBreakdown,
  PaymentMethod,
  Playbook,
  RecoveryAttempt,
  RecoveryJob,
  RecoveryStatus,
  TrendPoint,
} from '@/domain';
import { isoDaysAgo, isoMinutesFromNow } from '@/lib/datetime';
import { createRng, intBetween, pick, weighted } from './prng';
import { scorePayment, selectAction } from './rulesEngine';

/**
 * Development dataset.
 *
 * Shaped to look like a mid-size Indian D2C merchant on Razorpay Test Mode:
 * roughly 4% of attempted volume fails, insufficient funds dominates, and
 * subscription mandates make up the long tail. Every figure the UI shows is
 * derived from the job list below, so the dashboard, queue, analytics and
 * audit trail always agree with each other.
 *
 * This module is only reachable through the seed adapter, which the app uses
 * when the Rust engine is not available. It is never bundled into a decision.
 */

const SEED = 20260822;

const FIRST_NAMES = [
  'Aarav', 'Diya', 'Vihaan', 'Ananya', 'Advait', 'Ishita', 'Kabir', 'Meera',
  'Rohan', 'Saanvi', 'Arjun', 'Nikita', 'Devansh', 'Priya', 'Yash', 'Tara',
  'Imran', 'Fatima', 'Joseph', 'Neha', 'Karthik', 'Lakshmi', 'Siddharth', 'Ritu',
] as const;

const LAST_NAMES = [
  'Sharma', 'Iyer', 'Patel', 'Reddy', 'Nair', 'Banerjee', 'Kulkarni', 'Menon',
  'Gupta', 'Chauhan', 'Desai', 'Fernandes', 'Ahmed', 'Bose', 'Rao', 'Sethi',
] as const;

const CARD_ISSUERS = [
  'HDFC Bank', 'ICICI Bank', 'State Bank of India', 'Axis Bank',
  'Kotak Mahindra Bank', 'IDFC FIRST Bank', 'Yes Bank', 'Bank of Baroda',
] as const;

const UPI_HANDLES = ['@okhdfcbank', '@ybl', '@paytm', '@apl', '@okaxis'] as const;
const CARD_NETWORKS = ['VISA', 'Mastercard', 'RuPay'] as const;

const GATEWAY_TEXT: Record<FailureReason, string> = {
  insufficient_funds: 'Your account does not have enough balance to complete this transaction.',
  card_expired: 'Your card has expired. Please use a different card.',
  invalid_card: 'Payment failed because the card details are incorrect.',
  do_not_honour: 'Payment was declined by your bank. Please contact your bank.',
  authentication_timeout: 'Payment failed because authentication could not be completed.',
  bank_downtime: 'Your bank is facing technical difficulties. Please try later.',
  upi_collect_expired: 'The UPI collect request expired without a response.',
  mandate_revoked: 'The mandate registered for this subscription is no longer active.',
  limit_exceeded: 'This transaction exceeds the limit set on your card.',
  gateway_timeout: 'Payment could not be confirmed in time.',
};

/** Reason mix, tuned to published Indian failure distributions. */
const REASON_MIX: readonly (readonly [FailureReason, number])[] = [
  ['insufficient_funds', 26],
  ['authentication_timeout', 17],
  ['do_not_honour', 14],
  ['bank_downtime', 9],
  ['upi_collect_expired', 9],
  ['card_expired', 8],
  ['gateway_timeout', 6],
  ['limit_exceeded', 5],
  ['invalid_card', 4],
  ['mandate_revoked', 2],
];

/** Reasons only occur on the rails that can produce them. */
const METHODS_FOR_REASON: Record<FailureReason, readonly PaymentMethod[]> = {
  insufficient_funds: ['card', 'upi', 'netbanking', 'emandate'],
  card_expired: ['card'],
  invalid_card: ['card'],
  do_not_honour: ['card', 'netbanking'],
  authentication_timeout: ['card', 'netbanking', 'emi'],
  bank_downtime: ['netbanking', 'upi', 'emandate'],
  upi_collect_expired: ['upi'],
  mandate_revoked: ['emandate'],
  limit_exceeded: ['card', 'upi', 'wallet'],
  gateway_timeout: ['card', 'upi', 'netbanking', 'wallet'],
};

const rng = createRng(SEED);

function id(prefix: string, n: number): string {
  return `${prefix}_${(SEED + n * 7919).toString(36).toUpperCase().slice(-10)}`;
}

function makeCustomer(n: number): CustomerRef {
  const first = pick(rng, FIRST_NAMES);
  const last = pick(rng, LAST_NAMES);
  const handle = `${first.toLowerCase()}.${last.toLowerCase()}`;
  const successfulPayments = weighted(rng, [
    [0, 18],
    [intBetween(rng, 1, 4), 42],
    [intBetween(rng, 5, 23), 40],
  ]);

  return {
    id: id('cust', n),
    name: `${first} ${last}`,
    email: `${handle}@example.in`,
    phoneMasked: `+91 ${intBetween(rng, 70, 99)}••• ••${intBetween(rng, 10, 99)}`,
    lifetimeValuePaise: intBetween(rng, 2, 260) * 1_00_000,
    successfulPayments,
  };
}

function makePayment(n: number): FailedPayment {
  const failureReason = weighted(rng, REASON_MIX);
  const method = pick(rng, METHODS_FOR_REASON[failureReason]);
  const isSubscription = method === 'emandate' || (method === 'card' && rng() < 0.28);

  const amountPaise = isSubscription
    ? pick(rng, [29_900, 49_900, 99_900, 1_49_900, 2_99_900, 5_99_900])
    : weighted(rng, [
        [intBetween(rng, 3, 18) * 1_00_00, 46], // ₹300 - ₹1,800
        [intBetween(rng, 20, 149) * 1_00_00, 38], // ₹2,000 - ₹14,900
        [intBetween(rng, 250, 1_200) * 1_00_00, 16], // ₹25,000 - ₹1,20,000
      ]);

  return {
    id: id('job', n),
    razorpayPaymentId: `pay_${id('x', n).slice(2).replace(/_/g, '')}`,
    razorpayOrderId: `order_${id('o', n + 500).slice(2).replace(/_/g, '')}`,
    customer: makeCustomer(n),
    amountPaise,
    method,
    cardNetwork: method === 'card' || method === 'emi' ? pick(rng, CARD_NETWORKS) : null,
    issuer:
      method === 'upi'
        ? `${pick(rng, ['user', 'pay', 'acct'])}${pick(rng, UPI_HANDLES)}`
        : pick(rng, CARD_ISSUERS),
    failureReason,
    gatewayDescription: GATEWAY_TEXT[failureReason],
    // Spread across the widest window the UI offers. A dataset that only
    // covers a fortnight makes the 14D and 30D filters return identical
    // figures, which reads as a broken filter rather than a quiet month.
    failedAt: isoDaysAgo(rng() * 29.5),
    attemptCount: weighted(rng, [
      [1, 58],
      [2, 26],
      [3, 11],
      [4, 5],
    ]),
    isSubscription,
  };
}

/** Status is correlated with the score so the queue reads believably. */
function statusFor(score: number, roll: number): RecoveryStatus {
  if (roll < score * 0.52) return 'recovered';
  if (roll < 0.58) return pick(rng, ['scheduled', 'scheduled', 'in_progress', 'queued']);
  if (roll < 0.76) return 'awaiting_customer';
  if (roll < 0.86) return 'failed';
  if (roll < 0.94) return 'written_off';
  return 'suppressed';
}

const TERMINAL: readonly RecoveryStatus[] = ['recovered', 'failed', 'written_off'];

function buildAttempts(job: Omit<RecoveryJob, 'attempts'>): RecoveryAttempt[] {
  const attempts: RecoveryAttempt[] = [];
  const { payment, recommendedAction, status } = job;
  const total = status === 'queued' ? 0 : Math.min(payment.attemptCount, 4);
  const age = daysSince(payment.failedAt);
  // One rung every 0.35 days, compressed when the failure is too recent to fit
  // them all in, so that even a fourth attempt on a payment that failed five
  // hours ago still lands strictly between the failure and now.
  const step = Math.min(0.35, age / (total + 1));

  for (let i = 0; i < total; i += 1) {
    const isLast = i === total - 1;
    const outcome =
      isLast && status === 'recovered'
        ? 'succeeded'
        : isLast && status === 'awaiting_customer'
          ? 'delivered'
          : isLast && status === 'in_progress'
            ? 'pending'
            : isLast && status === 'suppressed'
              ? 'skipped'
              : 'failed';

    attempts.push({
      id: `${job.id}-a${i + 1}`,
      sequence: i + 1,
      kind: i === 0 ? 'auto_retry' : recommendedAction.kind,
      channel: i === 0 ? 'gateway' : recommendedAction.channel,
      // The ladder walks *forward* from the failure: sequence 1 is the oldest.
      // Dated the other way round, the drawer timeline shows the success above
      // the failures that led to it, and the analytics buckets — which count an
      // attempt on the day it ran — put late retries in early days.
      occurredAt: isoDaysAgo(age - (i + 1) * step),
      outcome,
      note:
        outcome === 'succeeded'
          ? `Captured ${payment.razorpayPaymentId} on retry ${i + 1}`
          : outcome === 'delivered'
            ? 'Message delivered, awaiting customer action'
            : outcome === 'pending'
              ? 'Charge submitted, awaiting gateway confirmation'
              : outcome === 'skipped'
                ? 'Held back by contact-frequency cap'
                : payment.gatewayDescription,
    });
  }

  return attempts;
}

function daysSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 86_400_000;
}

/**
 * One definition of "the last N days", used by every windowed figure.
 *
 * The window is N calendar days ending today, not an instant N*24h back: the
 * trend chart has to bucket by date, and if the KPI above it used a rolling
 * instant the two would disagree by up to a day's worth of failures — which is
 * the kind of gap a merchant notices when reconciling by hand.
 */
function windowStart(windowDays: number): string {
  return isoDaysAgo(Math.max(0, windowDays - 1)).slice(0, 10);
}

function inWindow(job: RecoveryJob, windowDays: number): boolean {
  return job.payment.failedAt.slice(0, 10) >= windowStart(windowDays);
}

/** Money still in play: recovered is won, written off is lost, the rest is at risk. */
function isAtRisk(job: RecoveryJob): boolean {
  return job.status !== 'recovered' && job.status !== 'written_off';
}

function buildJobs(count: number): RecoveryJob[] {
  const jobs: RecoveryJob[] = [];

  for (let n = 0; n < count; n += 1) {
    const payment = makePayment(n);
    const scored = scorePayment(payment);
    const action = selectAction(payment, scored);
    const status = statusFor(scored.score, rng());
    const isTerminal = TERMINAL.includes(status);

    const base: Omit<RecoveryJob, 'attempts'> = {
      id: payment.id,
      payment,
      status,
      riskTier: scored.riskTier,
      recoveryScore: scored.score,
      recommendedAction: action,
      nextActionAt:
        isTerminal || status === 'suppressed'
          ? null
          : isoMinutesFromNow(intBetween(rng, 4, action.delayMinutes || 45)),
      recoveredAmountPaise: status === 'recovered' ? payment.amountPaise : null,
      slaExpiresAt: isoMinutesFromNow(intBetween(rng, -600, 6 * 24 * 60)),
      createdAt: payment.failedAt,
      updatedAt: isoDaysAgo(rng() * Math.max(0.05, daysSince(payment.failedAt))),
      assignedTo: status === 'suppressed' || scored.riskTier === 'critical' ? 'Priya Menon' : null,
    };

    jobs.push({ ...base, attempts: buildAttempts(base) });
  }

  return jobs.sort((a, b) => b.payment.failedAt.localeCompare(a.payment.failedAt));
}

export const JOBS: RecoveryJob[] = buildJobs(74);

const STAGE_FOR_STATUS: Record<RecoveryStatus, FunnelStage> = {
  recovered: 'recovered',
  scheduled: 'in_flight',
  in_progress: 'in_flight',
  queued: 'at_risk',
  awaiting_customer: 'awaiting_customer',
  failed: 'at_risk',
  suppressed: 'at_risk',
  written_off: 'written_off',
};

const ACTIVE: readonly RecoveryStatus[] = [
  'queued',
  'scheduled',
  'in_progress',
  'awaiting_customer',
];

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

export function buildFunnel(jobs: RecoveryJob[]): FunnelSegment[] {
  const order: FunnelStage[] = [
    'recovered',
    'in_flight',
    'awaiting_customer',
    'at_risk',
    'written_off',
  ];
  const totals: Record<FunnelStage, FunnelSegment> = {
    recovered: { stage: 'recovered', amountPaise: 0, jobCount: 0 },
    in_flight: { stage: 'in_flight', amountPaise: 0, jobCount: 0 },
    awaiting_customer: { stage: 'awaiting_customer', amountPaise: 0, jobCount: 0 },
    at_risk: { stage: 'at_risk', amountPaise: 0, jobCount: 0 },
    written_off: { stage: 'written_off', amountPaise: 0, jobCount: 0 },
  };

  for (const job of jobs) {
    const segment = totals[STAGE_FOR_STATUS[job.status]];
    segment.amountPaise += job.payment.amountPaise;
    segment.jobCount += 1;
  }

  return order.map((stage) => totals[stage]);
}

/** Totals for one window. */
interface WindowTotals {
  jobs: RecoveryJob[];
  failedPaise: number;
  recoveredPaise: number;
  atRiskPaise: number;
  activeJobs: number;
}

/**
 * Every windowed figure on the dashboard, built from one pass.
 *
 * Shared shape on purpose: a KPI card and the delta underneath it are derived
 * from the same object, so they can never end up describing different
 * quantities. `until` is exclusive, which is what makes the previous window abut
 * the current one exactly.
 */
function totals(allJobs: RecoveryJob[], from: string, until: string | null): WindowTotals {
  const jobs = allJobs.filter((job) => {
    const day = job.payment.failedAt.slice(0, 10);
    return day >= from && (until === null || day < until);
  });

  return {
    jobs,
    failedPaise: sum(jobs.map((j) => j.payment.amountPaise)),
    recoveredPaise: sum(jobs.map((j) => (j.status === 'recovered' ? (j.recoveredAmountPaise ?? 0) : 0))),
    atRiskPaise: sum(jobs.filter(isAtRisk).map((j) => j.payment.amountPaise)),
    activeJobs: jobs.filter((j) => ACTIVE.includes(j.status)).length,
  };
}

/**
 * Recovered as a share of everything that failed in the window — written-off
 * money included.
 *
 * Excluding it from the denominator would mean the rate climbed every time the
 * team gave up on a job, which is precisely backwards. This also matches
 * `Totals::recovery_rate` in `src-tauri/src/db/metrics.rs`; the two adapters
 * reporting different rates for the same rows is the sort of discrepancy that
 * gets noticed in a demo.
 */
function recoveryRateOf(window: WindowTotals): number {
  if (window.failedPaise <= 0) return 0;
  return Math.min(1, Math.max(0, window.recoveredPaise / window.failedPaise));
}

/**
 * Fractional change against the previous equivalent window.
 *
 * No baseline reads as flat rather than as infinite growth: a merchant in their
 * first week would otherwise see a nonsense percentage on every card.
 */
function change(current: number, previous: number): number {
  return Math.abs(previous) < Number.EPSILON ? 0 : (current - previous) / previous;
}

export function buildMetrics(allJobs: RecoveryJob[], windowDays: number): DashboardMetrics {
  const days = Math.max(1, windowDays);
  const start = windowStart(days);
  const current = totals(allJobs, start, null);
  const previous = totals(allJobs, windowStart(days * 2), start);

  return {
    windowDays,
    generatedAt: new Date().toISOString(),
    revenueAtRiskPaise: current.atRiskPaise,
    recoveredPaise: current.recoveredPaise,
    recoveryRate: recoveryRateOf(current),
    activeJobs: current.activeJobs,
    // Measured against the previous equivalent window, not invented. These were
    // four hardcoded constants, so every card claimed the same movement for 7D,
    // 14D and 30D alike and none of them budged when a recovery was approved —
    // a number that never moves after you act on it is worse than no number.
    deltas: {
      revenueAtRisk: {
        change: change(current.atRiskPaise, previous.atRiskPaise),
        higherIsBetter: false,
      },
      recovered: {
        change: change(current.recoveredPaise, previous.recoveredPaise),
        higherIsBetter: true,
      },
      recoveryRate: {
        change: change(recoveryRateOf(current), recoveryRateOf(previous)),
        higherIsBetter: true,
      },
      activeJobs: {
        change: change(current.activeJobs, previous.activeJobs),
        higherIsBetter: false,
      },
    },
    funnel: {
      totalPaise: current.failedPaise,
      segments: buildFunnel(current.jobs),
    },
  };
}

/**
 * Daily series over the same window as the KPIs above it, derived from the same
 * rows. Money is bucketed on the day the payment failed; attempts are bucketed
 * on the day they ran, because a payday retry belongs to the day it fired.
 */
export function buildTrend(allJobs: RecoveryJob[], windowDays: number): TrendPoint[] {
  const days = new Map<string, { atRiskPaise: number; recoveredPaise: number; attempts: number }>();

  for (let i = Math.max(1, windowDays) - 1; i >= 0; i -= 1) {
    days.set(isoDaysAgo(i).slice(0, 10), { atRiskPaise: 0, recoveredPaise: 0, attempts: 0 });
  }

  for (const job of allJobs) {
    const bucket = days.get(job.payment.failedAt.slice(0, 10));
    if (bucket) {
      bucket.recoveredPaise += job.recoveredAmountPaise ?? 0;
      if (isAtRisk(job)) bucket.atRiskPaise += job.payment.amountPaise;
    }

    for (const attempt of job.attempts) {
      const ran = days.get(attempt.occurredAt.slice(0, 10));
      if (ran) ran.attempts += 1;
    }
  }

  return [...days.entries()].map(([date, totals]) => {
    const denominator = totals.recoveredPaise + totals.atRiskPaise;
    return {
      date,
      atRiskPaise: totals.atRiskPaise,
      recoveredPaise: totals.recoveredPaise,
      recoveryRate: denominator === 0 ? 0 : totals.recoveredPaise / denominator,
      attempts: totals.attempts,
    };
  });
}

export function buildFailureBreakdown(
  allJobs: RecoveryJob[],
  windowDays: number,
): FailureBreakdown[] {
  const jobs = allJobs.filter((j) => inWindow(j, windowDays));
  const map = new Map<FailureReason, FailureBreakdown>();

  for (const job of jobs) {
    const key = job.payment.failureReason;
    const row =
      map.get(key) ??
      { reason: key, jobCount: 0, atRiskPaise: 0, recoveredPaise: 0, recoveryRate: 0 };
    row.jobCount += 1;
    row.recoveredPaise += job.recoveredAmountPaise ?? 0;
    if (isAtRisk(job)) row.atRiskPaise += job.payment.amountPaise;
    map.set(key, row);
  }

  return [...map.values()]
    .map((row) => ({
      ...row,
      recoveryRate:
        row.recoveredPaise + row.atRiskPaise === 0
          ? 0
          : row.recoveredPaise / (row.recoveredPaise + row.atRiskPaise),
    }))
    .sort((a, b) => b.atRiskPaise - a.atRiskPaise);
}

export function buildMethodBreakdown(
  allJobs: RecoveryJob[],
  windowDays: number,
): MethodBreakdown[] {
  const jobs = allJobs.filter((j) => inWindow(j, windowDays));
  const map = new Map<PaymentMethod, MethodBreakdown>();

  for (const job of jobs) {
    const key = job.payment.method;
    const row =
      map.get(key) ??
      { method: key, jobCount: 0, atRiskPaise: 0, recoveredPaise: 0, recoveryRate: 0 };
    row.jobCount += 1;
    row.recoveredPaise += job.recoveredAmountPaise ?? 0;
    if (isAtRisk(job)) row.atRiskPaise += job.payment.amountPaise;
    map.set(key, row);
  }

  return [...map.values()]
    .map((row) => ({
      ...row,
      recoveryRate:
        row.recoveredPaise + row.atRiskPaise === 0
          ? 0
          : row.recoveredPaise / (row.recoveredPaise + row.atRiskPaise),
    }))
    .sort((a, b) => b.jobCount - a.jobCount);
}

/**
 * Yield decays with each successive attempt: the basis for a retry budget.
 *
 * Counted from the attempts themselves, on the day each one ran, so a retry
 * that fired this week counts this week even if the payment failed last month.
 * That is the whole point of the panel — the strategies worth measuring
 * (payday re-presentment, multi-day dunning) are the slowest ones.
 */
export function buildAttemptEffectiveness(
  allJobs: RecoveryJob[],
  windowDays: number,
): AttemptEffectiveness[] {
  const start = windowStart(windowDays);
  const buckets = [1, 2, 3, 4].map((attempt) => ({
    attempt,
    attempted: 0,
    recovered: 0,
    recoveryRate: 0,
  }));

  for (const job of allJobs) {
    for (const attempt of job.attempts) {
      if (attempt.occurredAt.slice(0, 10) < start) continue;
      const bucket = buckets[Math.min(attempt.sequence, buckets.length) - 1];
      if (!bucket) continue;
      bucket.attempted += 1;
      if (attempt.outcome === 'succeeded') bucket.recovered += 1;
    }
  }

  return buckets.map((bucket) => ({
    ...bucket,
    recoveryRate: bucket.attempted === 0 ? 0 : bucket.recovered / bucket.attempted,
  }));
}

export function buildInsights(allJobs: RecoveryJob[]): Insight[] {
  const paydayCandidates = allJobs.filter(
    (j) => j.payment.failureReason === 'insufficient_funds' && j.status !== 'recovered',
  );
  const expiringMandates = allJobs.filter(
    (j) => j.payment.isSubscription && j.status === 'awaiting_customer',
  );
  const slaBreached = allJobs.filter(
    (j) =>
      new Date(j.slaExpiresAt).getTime() < Date.now() &&
      ACTIVE.includes(j.status) &&
      j.riskTier !== 'low',
  );
  const cardDeclines = allJobs.filter(
    (j) => j.payment.method === 'card' && j.payment.failureReason === 'do_not_honour',
  );

  return [
    {
      id: 'insight_payday_window',
      kind: 'opportunity',
      headline: 'Batch the insufficient-funds retries into the payday window',
      body: `${paydayCandidates.length} failures are waiting on customer balance. Re-presenting them between 06:30 and 10:00 on the 1st recovers 2.4x more than retrying immediately.`,
      impactPaise: sum(paydayCandidates.map((j) => j.payment.amountPaise)),
      confidence: 0.86,
      evidence: [
        { label: 'Sample size', weight: 0.4, detail: `${paydayCandidates.length} matching jobs in the window` },
        { label: 'Historical lift', weight: 0.33, detail: '2.4x versus immediate retry on the same cohort' },
        { label: 'Rail coverage', weight: 0.13, detail: 'Works on card, UPI autopay and e-mandate' },
      ],
      suggestedAction: {
        kind: 'retry_on_payday',
        label: 'Schedule payday retries',
        jobIds: paydayCandidates.slice(0, 12).map((j) => j.id),
      },
      detectedAt: isoDaysAgo(0.02),
    },
    {
      id: 'insight_mandate_expiry',
      kind: 'risk',
      headline: 'Subscription mandates are going stale before renewal',
      body: `${expiringMandates.length} subscribers have an unanswered card-update request. Each one becomes an involuntary churn if the mandate lapses before the next cycle.`,
      impactPaise: sum(expiringMandates.map((j) => j.payment.amountPaise)) * 6,
      confidence: 0.74,
      evidence: [
        { label: 'Unanswered requests', weight: 0.36, detail: `${expiringMandates.length} customers, no response in 48h` },
        { label: 'Annualised exposure', weight: 0.28, detail: 'Impact assumes six remaining billing cycles' },
        { label: 'Channel gap', weight: -0.18, detail: 'Only email was tried; WhatsApp is 3.1x more responsive' },
      ],
      suggestedAction: {
        kind: 'dunning_whatsapp',
        label: 'Follow up on WhatsApp',
        jobIds: expiringMandates.slice(0, 10).map((j) => j.id),
      },
      detectedAt: isoDaysAgo(0.15),
    },
    {
      id: 'insight_issuer_anomaly',
      kind: 'anomaly',
      headline: 'Do-not-honour declines are clustering on one issuer',
      body: `${cardDeclines.length} card declines came back as do-not-honour, well above this issuer's 14-day baseline. Silent retries are unlikely to clear until the issuer settles.`,
      impactPaise: sum(cardDeclines.map((j) => j.payment.amountPaise)),
      confidence: 0.68,
      evidence: [
        { label: 'Deviation', weight: 0.31, detail: '3.1x the trailing 14-day rate for this issuer' },
        { label: 'Concentration', weight: 0.22, detail: 'Single issuer accounts for most of the spike' },
        { label: 'Retry yield', weight: -0.24, detail: 'Immediate retries on this cohort recovered 9%' },
      ],
      suggestedAction: {
        kind: 'switch_to_upi',
        label: 'Route this cohort to UPI',
        jobIds: cardDeclines.slice(0, 8).map((j) => j.id),
      },
      detectedAt: isoDaysAgo(0.3),
    },
    {
      id: 'insight_sla_breach',
      kind: 'risk',
      headline: 'Recovery windows have closed on high-value jobs',
      body: `${slaBreached.length} jobs are past their recovery deadline and still show an open action. These need a human decision today or they should be written off.`,
      impactPaise: sum(slaBreached.map((j) => j.payment.amountPaise)),
      confidence: 0.93,
      evidence: [
        { label: 'Past deadline', weight: 0.45, detail: `${slaBreached.length} jobs beyond their SLA` },
        { label: 'Value concentration', weight: 0.24, detail: 'All are medium risk tier or above' },
      ],
      suggestedAction: {
        kind: 'human_review',
        label: 'Open the review list',
        jobIds: slaBreached.map((j) => j.id),
      },
      detectedAt: isoDaysAgo(0.05),
    },
  ];
}

export const PLAYBOOKS: Playbook[] = [
  {
    id: 'pb_payday',
    name: 'Payday re-present',
    description:
      'Hold insufficient-funds failures until the salary window, then re-present silently before contacting the customer.',
    enabled: true,
    trigger: {
      reasons: ['insufficient_funds'],
      methods: ['card', 'upi', 'netbanking', 'emandate'],
      minAmountPaise: null,
      subscriptionOnly: false,
    },
    steps: [
      { sequence: 1, kind: 'retry_on_payday', delayMinutes: 0, stopOnSuccess: true },
      { sequence: 2, kind: 'dunning_whatsapp', delayMinutes: 720, stopOnSuccess: true },
      { sequence: 3, kind: 'send_payment_link', delayMinutes: 2880, stopOnSuccess: true },
    ],
    stats: { jobsMatched: 412, recoveredPaise: 38_74_200, recoveryRate: 0.61 },
    updatedAt: isoDaysAgo(6),
  },
  {
    id: 'pb_downtime',
    name: 'Issuer downtime hold',
    description:
      'Pause retries while an issuer is degraded, then drain the backlog in small batches once it recovers.',
    enabled: true,
    trigger: {
      reasons: ['bank_downtime', 'gateway_timeout'],
      methods: ['netbanking', 'upi', 'card', 'emandate'],
      minAmountPaise: null,
      subscriptionOnly: false,
    },
    steps: [
      { sequence: 1, kind: 'retry_after_downtime', delayMinutes: 90, stopOnSuccess: true },
      { sequence: 2, kind: 'auto_retry', delayMinutes: 240, stopOnSuccess: true },
    ],
    stats: { jobsMatched: 168, recoveredPaise: 21_09_500, recoveryRate: 0.79 },
    updatedAt: isoDaysAgo(11),
  },
  {
    id: 'pb_card_refresh',
    name: 'Card refresh',
    description:
      'Ask for current card details when the instrument itself is dead, and offer UPI as the faster alternative.',
    enabled: true,
    trigger: {
      reasons: ['card_expired', 'invalid_card'],
      methods: ['card', 'emi'],
      minAmountPaise: null,
      subscriptionOnly: false,
    },
    steps: [
      { sequence: 1, kind: 'request_card_update', delayMinutes: 0, stopOnSuccess: true },
      { sequence: 2, kind: 'switch_to_upi', delayMinutes: 1440, stopOnSuccess: true },
      { sequence: 3, kind: 'dunning_email', delayMinutes: 4320, stopOnSuccess: true },
    ],
    stats: { jobsMatched: 97, recoveredPaise: 8_16_400, recoveryRate: 0.38 },
    updatedAt: isoDaysAgo(3),
  },
  {
    id: 'pb_checkout_dropoff',
    name: 'Checkout drop-off rescue',
    description:
      'Send a fresh hosted link within minutes of an abandoned authentication, while intent is still warm.',
    enabled: true,
    trigger: {
      reasons: ['authentication_timeout', 'upi_collect_expired'],
      methods: ['card', 'upi', 'netbanking', 'emi'],
      minAmountPaise: null,
      subscriptionOnly: false,
    },
    steps: [
      { sequence: 1, kind: 'send_payment_link', delayMinutes: 5, stopOnSuccess: true },
      { sequence: 2, kind: 'dunning_whatsapp', delayMinutes: 180, stopOnSuccess: true },
    ],
    stats: { jobsMatched: 288, recoveredPaise: 26_31_800, recoveryRate: 0.68 },
    updatedAt: isoDaysAgo(1),
  },
  {
    id: 'pb_high_value',
    name: 'High-value manual desk',
    description:
      'Route anything above ₹50,000 to a human before any automated contact goes out.',
    enabled: false,
    trigger: {
      reasons: ['do_not_honour', 'limit_exceeded', 'mandate_revoked'],
      methods: ['card', 'netbanking', 'emandate', 'emi'],
      minAmountPaise: 50_00_000,
      subscriptionOnly: false,
    },
    steps: [{ sequence: 1, kind: 'human_review', delayMinutes: 0, stopOnSuccess: true }],
    stats: { jobsMatched: 24, recoveredPaise: 14_50_000, recoveryRate: 0.42 },
    updatedAt: isoDaysAgo(19),
  },
];

export function buildAuditEvents(allJobs: RecoveryJob[]): AuditEvent[] {
  const events: AuditEvent[] = [];
  const auditRng = createRng(SEED + 31);

  for (const job of allJobs.slice(0, 34)) {
    events.push({
      id: `evt_ingest_${job.id}`,
      at: job.payment.failedAt,
      actor: { type: 'webhook', name: 'razorpay.payment.failed' },
      action: 'payment.failure.ingested',
      summary: `Ingested failed payment for ${job.payment.customer.name}`,
      severity: 'info',
      jobId: job.id,
      metadata: {
        payment_id: job.payment.razorpayPaymentId,
        order_id: job.payment.razorpayOrderId,
        reason: job.payment.failureReason,
        amount_paise: String(job.payment.amountPaise),
      },
    });

    events.push({
      id: `evt_score_${job.id}`,
      at: job.payment.failedAt,
      actor: { type: 'engine', name: 'recovery-engine' },
      action: 'job.scored',
      summary: `Scored ${(job.recoveryScore * 100).toFixed(0)}% recoverable, chose "${job.recommendedAction.label}"`,
      severity: 'info',
      jobId: job.id,
      metadata: {
        score: job.recoveryScore.toFixed(3),
        action: job.recommendedAction.kind,
        risk_tier: job.riskTier,
        signals: String(job.recommendedAction.signals.length),
      },
    });

    for (const attempt of job.attempts) {
      events.push({
        id: `evt_attempt_${attempt.id}`,
        at: attempt.occurredAt,
        actor: { type: 'engine', name: 'recovery-engine' },
        action: `job.attempt.${attempt.outcome}`,
        summary: `Attempt ${attempt.sequence} via ${attempt.channel}: ${attempt.outcome}`,
        severity:
          attempt.outcome === 'succeeded'
            ? 'notice'
            : attempt.outcome === 'failed'
              ? 'warning'
              : 'info',
        jobId: job.id,
        metadata: {
          sequence: String(attempt.sequence),
          kind: attempt.kind,
          channel: attempt.channel,
          note: attempt.note,
        },
      });
    }

    if (job.assignedTo) {
      events.push({
        id: `evt_assign_${job.id}`,
        at: job.updatedAt,
        actor: { type: 'user', name: job.assignedTo },
        action: 'job.assigned',
        summary: `${job.assignedTo} took ownership of this job`,
        severity: 'notice',
        jobId: job.id,
        metadata: { risk_tier: job.riskTier, status: job.status },
      });
    }
  }

  for (let i = 0; i < 10; i += 1) {
    const severity: AuditSeverity = pick(auditRng, ['info', 'info', 'notice', 'warning']);
    events.push({
      id: `evt_sweep_${i}`,
      at: isoDaysAgo(i * 0.42),
      actor: { type: 'system', name: 'scheduler' },
      action: 'engine.sweep.completed',
      summary: `Queue sweep processed ${intBetween(auditRng, 18, 74)} jobs`,
      severity,
      jobId: null,
      metadata: {
        duration_ms: String(intBetween(auditRng, 180, 2400)),
        rescheduled: String(intBetween(auditRng, 2, 19)),
      },
    });
  }

  events.push({
    id: 'evt_credentials',
    at: isoDaysAgo(14),
    actor: { type: 'user', name: 'Priya Menon' },
    action: 'razorpay.credentials.updated',
    summary: 'Connected Razorpay Test Mode credentials',
    severity: 'critical',
    jobId: null,
    metadata: { mode: 'test', key_id: 'rzp_test_••••••••4Xq2' },
  });

  events.push({
    id: 'evt_playbook_toggle',
    at: isoDaysAgo(19),
    actor: { type: 'user', name: 'Priya Menon' },
    action: 'playbook.disabled',
    summary: 'Disabled the "High-value manual desk" playbook',
    severity: 'warning',
    jobId: null,
    metadata: { playbook_id: 'pb_high_value', reason: 'Desk is short-staffed this quarter' },
  });

  return events.sort((a, b) => b.at.localeCompare(a.at));
}

export const MERCHANT: Merchant = {
  id: 'acc_KLm3RtNvQz',
  name: 'Kettle & Co.',
  mode: 'test',
};

export function buildEngineStatus(allJobs: RecoveryJob[]): EngineStatus {
  return {
    running: true,
    source: 'dev-seed',
    queueDepth: allJobs.filter((j) => ACTIVE.includes(j.status)).length,
    lastSweepAt: isoDaysAgo(0.004),
    razorpayConnected: false,
  };
}
