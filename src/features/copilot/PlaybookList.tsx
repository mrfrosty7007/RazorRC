import { ListChecks } from 'lucide-react';
import type { Playbook } from '@/domain';
import { FAILURE_REASONS, PAYMENT_METHODS, RECOVERY_ACTIONS } from '@/domain';
import { cn } from '@/lib/cn';
import { formatCount, formatINRCompact, formatPercent } from '@/lib/format';
import {
  EmptyState,
  Panel,
  PanelHeader,
  Skeleton,
  Tag,
  Toggle,
} from '@/components/ui';

interface PlaybookListProps {
  playbooks: Playbook[];
  loading?: boolean;
  pendingId: string | null;
  onToggle: (playbook: Playbook, enabled: boolean) => void;
  className?: string;
}

/**
 * The rules a merchant owns. Every recommendation on this page comes from one of
 * these, so they sit next to each other: turning a playbook off has to feel like
 * a consequential act, not a settings tweak buried three screens away.
 */
export function PlaybookList({
  playbooks,
  loading = false,
  pendingId,
  onToggle,
  className,
}: PlaybookListProps) {
  const enabledCount = playbooks.filter((playbook) => playbook.enabled).length;

  return (
    <Panel className={className}>
      <PanelHeader
        eyebrow="Automation"
        title="Playbooks"
        description="Ordered steps the engine runs when a failure matches"
        actions={
          <span className="font-mono text-micro text-content-faint">
            {formatCount(enabledCount)}/{formatCount(playbooks.length)} on
          </span>
        }
      />

      {loading ? (
        <div className="space-y-3 p-4">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : playbooks.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title="No playbooks yet"
          description="A playbook decides which action runs for which failure. Without one, every job waits for a human."
        />
      ) : (
        <ul className="divide-hairline-y">
          {playbooks.map((playbook) => (
            <li key={playbook.id} className={cn('p-4', !playbook.enabled && 'opacity-60')}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-[0.8125rem] font-semibold text-content">{playbook.name}</h3>
                  <p className="mt-0.5 text-xs leading-relaxed text-content-muted">
                    {playbook.description}
                  </p>
                </div>
                <Toggle
                  checked={playbook.enabled}
                  busy={pendingId === playbook.id}
                  onChange={(enabled) => onToggle(playbook, enabled)}
                  label={`${playbook.enabled ? 'Disable' : 'Enable'} the ${playbook.name} playbook`}
                  className="mt-0.5"
                />
              </div>

              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                {playbook.trigger.reasons.map((reason) => (
                  <Tag key={reason}>{FAILURE_REASONS[reason].label}</Tag>
                ))}
                {playbook.trigger.methods.map((method) => (
                  <Tag key={method}>{PAYMENT_METHODS[method].label}</Tag>
                ))}
                {playbook.trigger.minAmountPaise !== null ? (
                  <Tag>over {formatINRCompact(playbook.trigger.minAmountPaise)}</Tag>
                ) : null}
                {playbook.trigger.subscriptionOnly ? <Tag>subscriptions</Tag> : null}
              </div>

              {/* The step chain, read left to right, with the wait before each step. */}
              <ol className="mt-3 flex flex-wrap items-center gap-x-1.5 gap-y-1.5">
                {playbook.steps.map((step, index) => (
                  <li key={step.sequence} className="flex items-center gap-1.5">
                    {index > 0 ? (
                      <span aria-hidden className="text-content-faint">
                        →
                      </span>
                    ) : null}
                    <span className="rounded-control border border-hairline bg-raised px-1.5 py-0.5 text-micro text-content-muted">
                      <span className="font-mono text-content-faint">{step.sequence}</span>{' '}
                      {RECOVERY_ACTIONS[step.kind].label}
                      {step.delayMinutes > 0 ? (
                        <span className="ml-1 font-mono text-content-faint">
                          +{formatWait(step.delayMinutes)}
                        </span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ol>

              <dl className="mt-3 grid grid-cols-3 gap-3 border-t border-hairline pt-3">
                <Stat label="Matched" value={formatCount(playbook.stats.jobsMatched)} />
                <Stat label="Recovered" value={formatINRCompact(playbook.stats.recoveredPaise)} />
                <Stat label="Rate" value={formatPercent(playbook.stats.recoveryRate)} />
              </dl>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="eyebrow">{label}</dt>
      <dd className="mt-0.5 font-mono text-data-sm text-content">{value}</dd>
    </div>
  );
}

/** Compact wait label: playbook delays span minutes to days. */
function formatWait(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / (60 * 24))}d`;
}
