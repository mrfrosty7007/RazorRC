import {
  ATTEMPT_OUTCOMES,
  AUDIT_SEVERITIES,
  CHANNELS,
  FAILURE_REASONS,
  PAYMENT_METHODS,
  RECOVERY_ACTIONS,
  RECOVERY_STATUSES,
  RISK_TIERS,
  type AttemptOutcome,
  type AuditSeverity,
  type Channel,
  type FailureReason,
  type PaymentMethod,
  type RecoveryActionKind,
  type RecoveryStatus,
  type RiskTier,
} from '@/domain';
import { Badge, Tag } from '@/components/ui';

/**
 * Domain badges. Each reads its label, tone and tooltip from `domain/labels`,
 * so a status has the same word and the same colour on every screen.
 */

const LIVE_STATUSES: readonly RecoveryStatus[] = ['in_progress'];

export function StatusBadge({ status }: { status: RecoveryStatus }) {
  const spec = RECOVERY_STATUSES[status];
  return (
    <Badge tone={spec.tone} dot live={LIVE_STATUSES.includes(status)} title={spec.hint}>
      {spec.label}
    </Badge>
  );
}

export function RiskBadge({ tier }: { tier: RiskTier }) {
  const spec = RISK_TIERS[tier];
  return (
    <Badge tone={spec.tone} title={spec.hint}>
      {spec.label}
    </Badge>
  );
}

export function ReasonBadge({ reason }: { reason: FailureReason }) {
  const spec = FAILURE_REASONS[reason];
  return (
    <Badge tone={spec.tone} title={spec.hint}>
      {spec.label}
    </Badge>
  );
}

export function ActionBadge({ kind }: { kind: RecoveryActionKind }) {
  const spec = RECOVERY_ACTIONS[kind];
  return (
    <Badge tone={spec.tone} title={spec.hint}>
      {spec.label}
    </Badge>
  );
}

export function OutcomeBadge({ outcome }: { outcome: AttemptOutcome }) {
  const spec = ATTEMPT_OUTCOMES[outcome];
  return (
    <Badge tone={spec.tone} title={spec.hint}>
      {spec.label}
    </Badge>
  );
}

export function SeverityBadge({ severity }: { severity: AuditSeverity }) {
  const spec = AUDIT_SEVERITIES[severity];
  return (
    <Badge tone={spec.tone} dot title={spec.hint}>
      {spec.label}
    </Badge>
  );
}

export function MethodTag({ method, network }: { method: PaymentMethod; network?: string | null }) {
  const spec = PAYMENT_METHODS[method];
  return <Tag>{network ? `${spec.label} · ${network}` : spec.label}</Tag>;
}

export function ChannelTag({ channel }: { channel: Channel }) {
  return <Tag>{CHANNELS[channel].label}</Tag>;
}
