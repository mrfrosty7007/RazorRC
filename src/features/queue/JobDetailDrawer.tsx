import { Ban, PlayCircle, Check } from 'lucide-react';
import type { RecoveryJob } from '@/domain';
import { CHANNELS, RECOVERY_ACTIONS } from '@/domain';
import { Button, Callout, Drawer, KeyValue, ScoreTicks } from '@/components/ui';
import {
  ChannelTag,
  MethodTag,
  Money,
  OutcomeBadge,
  PaymentRef,
  ReasonBadge,
  RiskBadge,
  SignalList,
  StatusBadge,
} from '@/components/domain';
import { formatDayTime, formatRelative } from '@/lib/datetime';
import { formatPercent } from '@/lib/format';

interface JobDetailDrawerProps {
  job: RecoveryJob | null;
  onClose: () => void;
  onApprove?: (job: RecoveryJob) => void;
  onRetryNow?: (job: RecoveryJob) => void;
  onSuppress?: (job: RecoveryJob) => void;
  /** Job id currently being written, so the footer can show progress. */
  pendingId?: string | null;
  error?: string | null;
  /**
   * Opened for reference rather than for work -- from the audit trail, for
   * instance, where the job is evidence and acting on it would be a surprise.
   */
  readOnly?: boolean;
}

const TERMINAL_STATUSES = ['recovered', 'written_off'] as const;

/** Everything known about one job, including why the engine chose its action. */
export function JobDetailDrawer({
  job,
  onClose,
  onApprove,
  onRetryNow,
  onSuppress,
  pendingId,
  error,
  readOnly = false,
}: JobDetailDrawerProps) {
  if (!job) return null;

  const { payment, recommendedAction } = job;
  const busy = pendingId === job.id;
  const closed = TERMINAL_STATUSES.includes(job.status as (typeof TERMINAL_STATUSES)[number]);
  const actionable = !readOnly && !closed && Boolean(onApprove && onRetryNow && onSuppress);

  return (
    <Drawer
      open
      onClose={onClose}
      eyebrow={payment.razorpayOrderId}
      title={payment.customer.name}
      footer={
        actionable ? (
          <>
            <Button
              variant="primary"
              icon={<Check className="h-3.5 w-3.5" />}
              busy={busy}
              onClick={() => onApprove?.(job)}
            >
              Approve {RECOVERY_ACTIONS[recommendedAction.kind].label.toLowerCase()}
            </Button>
            <Button
              icon={<PlayCircle className="h-3.5 w-3.5" />}
              disabled={busy}
              onClick={() => onRetryNow?.(job)}
            >
              Retry now
            </Button>
            <Button
              variant="ghost"
              icon={<Ban className="h-3.5 w-3.5" />}
              disabled={busy}
              onClick={() => onSuppress?.(job)}
              className="ml-auto"
            >
              Stop automation
            </Button>
          </>
        ) : (
          <p className="text-xs text-content-muted">
            {closed
              ? 'This job is closed. Its history stays in the audit trail.'
              : 'Opened for reference. Work this job from the recovery queue.'}
          </p>
        )
      }
    >
      <div className="space-y-5 px-5 py-4">
        {error ? (
          <Callout tone="coral" title="That action did not go through">
            {error}
          </Callout>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={job.status} />
          <RiskBadge tier={job.riskTier} />
          <ReasonBadge reason={payment.failureReason} />
          <MethodTag method={payment.method} network={payment.cardNetwork} />
        </div>

        <div className="flex items-end justify-between gap-4 rounded-panel border border-hairline bg-raised px-3.5 py-3">
          <div>
            <p className="eyebrow">Amount at risk</p>
            <p className="mt-1 font-mono text-data-md text-content">
              <Money paise={payment.amountPaise} variant="exact" />
            </p>
          </div>
          <div className="text-right">
            <p className="eyebrow">Recovery score</p>
            <ScoreTicks value={job.recoveryScore} className="mt-1.5 justify-end" />
          </div>
        </div>

        <section>
          <h3 className="eyebrow mb-2.5">Payment</h3>
          <KeyValue
            items={[
              { label: 'Payment ID', value: <PaymentRef value={payment.razorpayPaymentId} /> },
              { label: 'Order ID', value: <PaymentRef value={payment.razorpayOrderId} /> },
              { label: 'Failed at', value: formatDayTime(payment.failedAt) },
              { label: 'Attempts so far', value: String(payment.attemptCount) },
              { label: 'Issuer', value: payment.issuer ?? '—' },
              {
                label: 'Recovery window',
                value: (
                  <span
                    className={
                      new Date(job.slaExpiresAt).getTime() < Date.now()
                        ? 'text-coral-soft'
                        : undefined
                    }
                  >
                    {formatRelative(job.slaExpiresAt)}
                  </span>
                ),
              },
              { label: 'Customer email', value: payment.customer.email },
              { label: 'Customer phone', value: payment.customer.phoneMasked },
            ]}
          />
        </section>

        <section>
          <h3 className="eyebrow mb-2">Gateway response</h3>
          <p
            className="rounded-panel border border-hairline bg-canvas px-3 py-2.5 font-mono text-micro leading-relaxed text-content-muted"
            data-selectable
          >
            {payment.gatewayDescription}
          </p>
        </section>

        <section className="rounded-panel border border-violet/30 bg-violet-dim/40 p-3.5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="eyebrow text-violet-soft">Engine recommendation</h3>
              <p className="mt-1.5 text-[0.9375rem] font-semibold text-content">
                {recommendedAction.label}
              </p>
              <p className="mt-1 text-xs text-content-muted">
                {CHANNELS[recommendedAction.channel].hint} ·{' '}
                {recommendedAction.delayMinutes === 0
                  ? 'fires immediately once approved'
                  : `waits ${formatDelay(recommendedAction.delayMinutes)} after approval`}
              </p>
            </div>
            <div className="shrink-0 text-right">
              <p className="eyebrow">Confidence</p>
              <p className="mt-1 font-mono text-data-md text-violet-soft">
                {formatPercent(recommendedAction.confidence, 0)}
              </p>
            </div>
          </div>

          <div className="mt-3.5 border-t border-violet/20 pt-3.5">
            <h4 className="eyebrow mb-2.5">Why this action</h4>
            <SignalList signals={recommendedAction.signals} />
          </div>
        </section>

        <section>
          <h3 className="eyebrow mb-2.5">Attempt history</h3>
          {job.attempts.length === 0 ? (
            <p className="text-xs text-content-faint">
              No attempt has run yet. The engine picks this job up on its next sweep.
            </p>
          ) : (
            <ol className="space-y-3">
              {job.attempts.map((attempt) => (
                <li key={attempt.id} className="border-l border-hairline pl-3.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-micro text-content-faint">
                      #{attempt.sequence}
                    </span>
                    <OutcomeBadge outcome={attempt.outcome} />
                    <ChannelTag channel={attempt.channel} />
                    <span className="font-mono text-micro text-content-faint">
                      {formatDayTime(attempt.occurredAt)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-content-muted">{attempt.note}</p>
                </li>
              ))}
            </ol>
          )}
        </section>

        {job.assignedTo ? (
          <Callout tone="amber" title={`Assigned to ${job.assignedTo}`}>
            A human owns this job. Automated steps stay paused until they hand it back.
          </Callout>
        ) : null}
      </div>
    </Drawer>
  );
}

function formatDelay(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} h`;
  return `${Math.round(minutes / (60 * 24))} days`;
}
