/**
 * RazorRC domain model.
 *
 * These types are the contract between the React app and the Rust recovery
 * engine. Every field here has a matching serde field in
 * `src-tauri/src/domain.rs`; keep the two in sync when either changes.
 *
 * Money is always an integer count of paise, matching the Razorpay API.
 * Timestamps are always ISO-8601 UTC strings.
 */

/** Normalised failure taxonomy, mapped from Razorpay error codes on ingest. */
export type FailureReason =
  | 'insufficient_funds'
  | 'card_expired'
  | 'invalid_card'
  | 'do_not_honour'
  | 'authentication_timeout'
  | 'bank_downtime'
  | 'upi_collect_expired'
  | 'mandate_revoked'
  | 'limit_exceeded'
  | 'gateway_timeout';

export type PaymentMethod = 'card' | 'upi' | 'netbanking' | 'wallet' | 'emandate' | 'emi';

export type RecoveryStatus =
  | 'queued'
  | 'scheduled'
  | 'in_progress'
  | 'awaiting_customer'
  | 'recovered'
  | 'failed'
  | 'written_off'
  | 'suppressed';

/** What the engine can do about a failure. One step of a playbook. */
export type RecoveryActionKind =
  | 'auto_retry'
  | 'retry_on_payday'
  | 'retry_after_downtime'
  | 'switch_to_upi'
  | 'request_card_update'
  | 'send_payment_link'
  | 'dunning_email'
  | 'dunning_whatsapp'
  | 'human_review';

export type RiskTier = 'critical' | 'high' | 'medium' | 'low';

export type AttemptOutcome = 'succeeded' | 'failed' | 'pending' | 'skipped' | 'delivered';

export type Channel = 'gateway' | 'email' | 'whatsapp' | 'sms' | 'in_app';

export interface CustomerRef {
  id: string;
  name: string;
  /** Masked at the source. The app never holds a full contact number. */
  email: string;
  phoneMasked: string;
  /** Lifetime value in paise; drives risk tiering. */
  lifetimeValuePaise: number;
  /** Successful payments to date, used as a trust signal by the engine. */
  successfulPayments: number;
}

export interface FailedPayment {
  id: string;
  /** `pay_...` from Razorpay. Unique per attempt. */
  razorpayPaymentId: string;
  /** `order_...` from Razorpay. Stable across retries of the same order. */
  razorpayOrderId: string;
  customer: CustomerRef;
  amountPaise: number;
  method: PaymentMethod;
  /** VISA / Mastercard / RuPay, when the method is a card. */
  cardNetwork: string | null;
  /** Issuing bank or UPI handle provider. */
  issuer: string | null;
  failureReason: FailureReason;
  /** Verbatim gateway description, shown to humans for ground truth. */
  gatewayDescription: string;
  failedAt: string;
  /** Attempts on this order so far, including the original charge. */
  attemptCount: number;
  isSubscription: boolean;
}

/** One weighted input to a score, surfaced verbatim in the UI. */
export interface Signal {
  label: string;
  /** Contribution to the score, -1..1. Negative signals lower it. */
  weight: number;
  detail: string;
}

export interface RecoveryAction {
  kind: RecoveryActionKind;
  /** Imperative, user-facing: "Retry on 1 Sep", not "RETRY_SCHEDULED". */
  label: string;
  channel: Channel;
  /** Engine confidence in this action, 0..1. */
  confidence: number;
  /** Why the engine chose it. Never empty. */
  signals: Signal[];
  /** Delay before the action fires, in minutes. 0 means immediately. */
  delayMinutes: number;
}

export interface RecoveryAttempt {
  id: string;
  sequence: number;
  kind: RecoveryActionKind;
  channel: Channel;
  occurredAt: string;
  outcome: AttemptOutcome;
  /** Gateway or provider response, kept for the audit trail. */
  note: string;
}

export interface RecoveryJob {
  id: string;
  payment: FailedPayment;
  status: RecoveryStatus;
  riskTier: RiskTier;
  /** Modelled probability this money comes back, 0..1. */
  recoveryScore: number;
  recommendedAction: RecoveryAction;
  attempts: RecoveryAttempt[];
  /** When the next scheduled action fires. Null when nothing is pending. */
  nextActionAt: string | null;
  recoveredAmountPaise: number | null;
  /** Recovery windows close: mandates lapse, carts go cold. */
  slaExpiresAt: string;
  createdAt: string;
  updatedAt: string;
  /** Set when a human overrode the engine, so the UI can say so. */
  assignedTo: string | null;
}

export type FunnelStage =
  | 'recovered'
  | 'in_flight'
  | 'awaiting_customer'
  | 'at_risk'
  | 'written_off';

export interface FunnelSegment {
  stage: FunnelStage;
  amountPaise: number;
  jobCount: number;
}

/** The dashboard's headline object: where every at-risk rupee currently sits. */
export interface RecoveryFunnel {
  totalPaise: number;
  segments: FunnelSegment[];
}

export interface MetricDelta {
  /** Fractional change against the previous equivalent window. */
  change: number;
  /** Whether an increase is good news for this metric. */
  higherIsBetter: boolean;
}

export interface DashboardMetrics {
  windowDays: number;
  generatedAt: string;
  revenueAtRiskPaise: number;
  recoveredPaise: number;
  /** Recovered / (recovered + at risk), 0..1. */
  recoveryRate: number;
  activeJobs: number;
  deltas: {
    revenueAtRisk: MetricDelta;
    recovered: MetricDelta;
    recoveryRate: MetricDelta;
    activeJobs: MetricDelta;
  };
  funnel: RecoveryFunnel;
}

export interface TrendPoint {
  /** ISO date, day granularity. */
  date: string;
  atRiskPaise: number;
  recoveredPaise: number;
  recoveryRate: number;
  attempts: number;
}

export interface FailureBreakdown {
  reason: FailureReason;
  jobCount: number;
  atRiskPaise: number;
  recoveredPaise: number;
  recoveryRate: number;
}

export interface MethodBreakdown {
  method: PaymentMethod;
  jobCount: number;
  atRiskPaise: number;
  recoveredPaise: number;
  recoveryRate: number;
}

/** How effective each successive retry is, used to cap retry budgets. */
export interface AttemptEffectiveness {
  attempt: number;
  attempted: number;
  recovered: number;
  recoveryRate: number;
}

export type InsightKind = 'opportunity' | 'risk' | 'anomaly';

/**
 * A finding produced by the recovery engine, not by a person. Always carries
 * its evidence so a merchant can disagree with it.
 */
export interface Insight {
  id: string;
  kind: InsightKind;
  headline: string;
  body: string;
  /** Rupees this finding is worth if acted on. */
  impactPaise: number;
  confidence: number;
  evidence: Signal[];
  suggestedAction: {
    kind: RecoveryActionKind;
    label: string;
    /** Jobs the action would apply to. */
    jobIds: string[];
  } | null;
  detectedAt: string;
}

export interface PlaybookStep {
  sequence: number;
  kind: RecoveryActionKind;
  delayMinutes: number;
  /** Skip this step when the previous one already recovered the money. */
  stopOnSuccess: boolean;
}

/** A merchant-editable rule set. The engine only ever runs enabled playbooks. */
export interface Playbook {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  trigger: {
    reasons: FailureReason[];
    methods: PaymentMethod[];
    minAmountPaise: number | null;
    subscriptionOnly: boolean;
  };
  steps: PlaybookStep[];
  stats: {
    jobsMatched: number;
    recoveredPaise: number;
    recoveryRate: number;
  };
  updatedAt: string;
}

export type ActorType = 'engine' | 'user' | 'webhook' | 'system';
export type AuditSeverity = 'info' | 'notice' | 'warning' | 'critical';

/** Append-only. Every state change in the system lands here. */
export interface AuditEvent {
  id: string;
  at: string;
  actor: { type: ActorType; name: string };
  /** Dotted machine action, e.g. `job.retry.scheduled`. */
  action: string;
  /** Human sentence for the same thing. */
  summary: string;
  severity: AuditSeverity;
  jobId: string | null;
  /** Flat key/value context; rendered as a definition list. */
  metadata: Record<string, string>;
}

export interface Merchant {
  id: string;
  name: string;
  mode: 'test' | 'live';
}

/** Health of the Rust recovery engine, polled by the sidebar. */
export interface EngineStatus {
  running: boolean;
  /** Human label for the data source currently backing the UI. */
  source: 'rust-engine' | 'dev-seed';
  queueDepth: number;
  lastSweepAt: string | null;
  /** Razorpay credentials present and accepted. */
  razorpayConnected: boolean;
}

export interface QueueFilters {
  statuses: RecoveryStatus[];
  reasons: FailureReason[];
  methods: PaymentMethod[];
  riskTiers: RiskTier[];
  /** Matches customer name, email, payment id or order id. */
  search: string;
}

export interface Paged<T> {
  rows: T[];
  total: number;
}
