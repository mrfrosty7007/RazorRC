import type {
  AttemptOutcome,
  AuditSeverity,
  Channel,
  FailureReason,
  FunnelStage,
  InsightKind,
  PaymentMethod,
  RecoveryActionKind,
  RecoveryStatus,
  RiskTier,
} from './types';

/**
 * Single source of user-facing vocabulary. Enum values never reach the screen.
 *
 * `tone` maps a value onto the palette's meaning-bearing hues so a status
 * badge, a chart series and a timeline dot all colour the same concept the
 * same way. Nothing picks a colour locally.
 */
export type Tone = 'neutral' | 'azure' | 'mint' | 'amber' | 'coral' | 'violet';

export interface LabelSpec {
  label: string;
  tone: Tone;
  /** One line of plain explanation, used in tooltips and legends. */
  hint: string;
}

export const FAILURE_REASONS: Record<FailureReason, LabelSpec> = {
  insufficient_funds: {
    label: 'Insufficient funds',
    tone: 'amber',
    hint: 'Account did not have the balance. Usually recoverable after payday.',
  },
  card_expired: {
    label: 'Card expired',
    tone: 'coral',
    hint: 'Needs new card details from the customer before any retry.',
  },
  invalid_card: {
    label: 'Invalid card',
    tone: 'coral',
    hint: 'Card details were wrong or the card was blocked by the issuer.',
  },
  do_not_honour: {
    label: 'Do not honour',
    tone: 'amber',
    hint: 'Issuer declined without a reason. Often clears on a later retry.',
  },
  authentication_timeout: {
    label: 'OTP not completed',
    tone: 'azure',
    hint: 'Customer dropped off during 3DS or OTP. A fresh link usually works.',
  },
  bank_downtime: {
    label: 'Bank downtime',
    tone: 'azure',
    hint: 'Issuer was unavailable. Retry once the bank is back up.',
  },
  upi_collect_expired: {
    label: 'UPI request expired',
    tone: 'azure',
    hint: 'Collect request timed out unanswered. Send a new one.',
  },
  mandate_revoked: {
    label: 'Mandate revoked',
    tone: 'coral',
    hint: 'Customer cancelled the e-mandate. Needs a new authorisation.',
  },
  limit_exceeded: {
    label: 'Limit exceeded',
    tone: 'amber',
    hint: 'Per-transaction or daily cap hit. Retry later or split the charge.',
  },
  gateway_timeout: {
    label: 'Gateway timeout',
    tone: 'azure',
    hint: 'No response in time. Safe to retry once the status is confirmed.',
  },
};

export const PAYMENT_METHODS: Record<PaymentMethod, LabelSpec> = {
  card: { label: 'Card', tone: 'neutral', hint: 'Credit or debit card' },
  upi: { label: 'UPI', tone: 'neutral', hint: 'Unified Payments Interface' },
  netbanking: { label: 'Netbanking', tone: 'neutral', hint: 'Bank transfer' },
  wallet: { label: 'Wallet', tone: 'neutral', hint: 'Prepaid wallet' },
  emandate: { label: 'e-Mandate', tone: 'neutral', hint: 'Recurring bank debit' },
  emi: { label: 'EMI', tone: 'neutral', hint: 'Instalment plan' },
};

export const RECOVERY_STATUSES: Record<RecoveryStatus, LabelSpec> = {
  queued: { label: 'Queued', tone: 'neutral', hint: 'Waiting for the engine to pick it up' },
  scheduled: { label: 'Scheduled', tone: 'azure', hint: 'Next action has a fire time' },
  in_progress: { label: 'In progress', tone: 'azure', hint: 'Action running right now' },
  awaiting_customer: {
    label: 'Awaiting customer',
    tone: 'amber',
    hint: 'Ball is with the customer -- link sent, card update requested',
  },
  recovered: { label: 'Recovered', tone: 'mint', hint: 'Payment captured' },
  failed: { label: 'Failed', tone: 'coral', hint: 'All playbook steps ran without success' },
  written_off: { label: 'Written off', tone: 'coral', hint: 'Recovery window closed' },
  suppressed: {
    label: 'Suppressed',
    tone: 'neutral',
    hint: 'Held back by a human or a contact-frequency cap',
  },
};

export const RISK_TIERS: Record<RiskTier, LabelSpec> = {
  critical: { label: 'Critical', tone: 'coral', hint: 'High value and closing fast' },
  high: { label: 'High', tone: 'amber', hint: 'Worth a human look today' },
  medium: { label: 'Medium', tone: 'azure', hint: 'Engine is handling it' },
  low: { label: 'Low', tone: 'neutral', hint: 'Low value, fully automated' },
};

export const RECOVERY_ACTIONS: Record<RecoveryActionKind, LabelSpec> = {
  auto_retry: { label: 'Retry charge', tone: 'azure', hint: 'Re-present the same instrument' },
  retry_on_payday: {
    label: 'Retry on payday',
    tone: 'azure',
    hint: 'Wait for salary credit before re-presenting',
  },
  retry_after_downtime: {
    label: 'Retry after downtime',
    tone: 'azure',
    hint: 'Hold until the issuer reports healthy',
  },
  switch_to_upi: { label: 'Offer UPI', tone: 'azure', hint: 'Route around a failing card' },
  request_card_update: {
    label: 'Request new card',
    tone: 'amber',
    hint: 'Ask the customer for current card details',
  },
  send_payment_link: { label: 'Send payment link', tone: 'azure', hint: 'One-tap hosted checkout' },
  dunning_email: { label: 'Email reminder', tone: 'neutral', hint: 'Templated recovery email' },
  dunning_whatsapp: { label: 'WhatsApp reminder', tone: 'neutral', hint: 'Approved template message' },
  human_review: { label: 'Human review', tone: 'coral', hint: 'Engine is not confident enough to act' },
};

export const CHANNELS: Record<Channel, LabelSpec> = {
  gateway: { label: 'Gateway', tone: 'azure', hint: 'Direct charge attempt' },
  email: { label: 'Email', tone: 'neutral', hint: 'Email to the customer' },
  whatsapp: { label: 'WhatsApp', tone: 'mint', hint: 'WhatsApp Business message' },
  sms: { label: 'SMS', tone: 'neutral', hint: 'Text message' },
  in_app: { label: 'In-app', tone: 'neutral', hint: 'Shown inside your product' },
};

export const ATTEMPT_OUTCOMES: Record<AttemptOutcome, LabelSpec> = {
  succeeded: { label: 'Succeeded', tone: 'mint', hint: 'Money captured' },
  failed: { label: 'Failed', tone: 'coral', hint: 'Attempt was declined' },
  pending: { label: 'Pending', tone: 'azure', hint: 'Waiting on a response' },
  skipped: { label: 'Skipped', tone: 'neutral', hint: 'Condition no longer applied' },
  delivered: { label: 'Delivered', tone: 'azure', hint: 'Message reached the customer' },
};

export const FUNNEL_STAGES: Record<FunnelStage, LabelSpec> = {
  recovered: { label: 'Recovered', tone: 'mint', hint: 'Back in your account' },
  in_flight: { label: 'In flight', tone: 'azure', hint: 'Engine is actively working these' },
  awaiting_customer: { label: 'Awaiting customer', tone: 'amber', hint: 'Needs a customer action' },
  at_risk: { label: 'Still at risk', tone: 'coral', hint: 'No action taken yet' },
  written_off: { label: 'Written off', tone: 'neutral', hint: 'Recovery window closed' },
};

export const INSIGHT_KINDS: Record<InsightKind, LabelSpec> = {
  opportunity: { label: 'Opportunity', tone: 'mint', hint: 'Money you can win back' },
  risk: { label: 'Risk', tone: 'amber', hint: 'Money about to be lost' },
  anomaly: { label: 'Anomaly', tone: 'violet', hint: 'Pattern broke from its baseline' },
};

export const AUDIT_SEVERITIES: Record<AuditSeverity, LabelSpec> = {
  info: { label: 'Info', tone: 'neutral', hint: 'Routine activity' },
  notice: { label: 'Notice', tone: 'azure', hint: 'Worth knowing about' },
  warning: { label: 'Warning', tone: 'amber', hint: 'Needs attention soon' },
  critical: { label: 'Critical', tone: 'coral', hint: 'Acted on money or credentials' },
};

/** Tailwind class sets per tone, so tone -> pixels happens in exactly one place. */
export const TONE_CLASSES: Record<Tone, { text: string; bg: string; border: string; dot: string; fill: string }> = {
  neutral: {
    text: 'text-content-muted',
    bg: 'bg-overlay',
    border: 'border-hairline-strong',
    dot: 'bg-content-faint',
    fill: '#5F6E8A',
  },
  azure: {
    text: 'text-azure-soft',
    bg: 'bg-azure-dim',
    border: 'border-azure/40',
    dot: 'bg-azure',
    fill: '#3D7DFF',
  },
  mint: {
    text: 'text-mint-soft',
    bg: 'bg-mint-dim',
    border: 'border-mint/40',
    dot: 'bg-mint',
    fill: '#17C79A',
  },
  amber: {
    text: 'text-amber-soft',
    bg: 'bg-amber-dim',
    border: 'border-amber/40',
    dot: 'bg-amber',
    fill: '#F0A32B',
  },
  coral: {
    text: 'text-coral-soft',
    bg: 'bg-coral-dim',
    border: 'border-coral/40',
    dot: 'bg-coral',
    fill: '#FF5C72',
  },
  violet: {
    text: 'text-violet-soft',
    bg: 'bg-violet-dim',
    border: 'border-violet/40',
    dot: 'bg-violet',
    fill: '#8B7BFF',
  },
};

export function toneFill(tone: Tone): string {
  return TONE_CLASSES[tone].fill;
}
