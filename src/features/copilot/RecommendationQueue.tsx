import { ChevronRight, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { RecoveryActionKind, RecoveryJob } from '@/domain';
import { RECOVERY_ACTIONS, TONE_CLASSES } from '@/domain';
import { cn } from '@/lib/cn';
import { formatCount, formatINRCompact, formatPercent } from '@/lib/format';
import { formatRelative } from '@/lib/datetime';
import {
  Badge,
  Button,
  EmptyState,
  Panel,
  PanelHeader,
  Skeleton,
} from '@/components/ui';
import { ActionBadge, ChannelTag, Money, ReasonBadge, SignalList } from '@/components/domain';

interface Group {
  kind: RecoveryActionKind;
  jobs: RecoveryJob[];
  amountPaise: number;
  /** Mean engine confidence across the group. */
  confidence: number;
}

interface RecommendationQueueProps {
  jobs: RecoveryJob[];
  loading?: boolean;
  /** Job currently being written, so only its buttons go busy. */
  pendingId: string | null;
  onApprove: (job: RecoveryJob) => void;
  onSuppress: (job: RecoveryJob) => void;
  onOpenJob: (job: RecoveryJob) => void;
  className?: string;
}

/**
 * What the engine wants to do next, grouped by action.
 *
 * This is the honest version of an "AI assistant": every line is a rule that
 * fired on the merchant's own data, the evidence is attached, and approving is a
 * real write. Nothing is generated prose.
 */
export function RecommendationQueue({
  jobs,
  loading = false,
  pendingId,
  onApprove,
  onSuppress,
  onOpenJob,
  className,
}: RecommendationQueueProps) {
  const groups = useMemo(() => groupByAction(jobs), [jobs]);
  const [openKind, setOpenKind] = useState<RecoveryActionKind | null>(null);

  const totalPaise = groups.reduce((sum, group) => sum + group.amountPaise, 0);

  return (
    <Panel className={className}>
      <PanelHeader
        eyebrow="Recovery engine"
        title="Recommended next actions"
        description="Grouped by what the engine would do, ranked by rupees at stake"
        actions={
          <Badge tone="violet" dot live>
            Deterministic rules
          </Badge>
        }
      />

      {loading ? (
        <div className="space-y-3 p-4">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : groups.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          title="Nothing is waiting on you"
          description="Every open job already has an approved action scheduled. New recommendations appear here as payments fail."
        />
      ) : (
        <ul className="divide-hairline-y">
          {groups.map((group) => {
            const spec = RECOVERY_ACTIONS[group.kind];
            const expanded = openKind === group.kind;
            const share = totalPaise === 0 ? 0 : group.amountPaise / totalPaise;

            return (
              <li key={group.kind}>
                <button
                  type="button"
                  onClick={() => setOpenKind(expanded ? null : group.kind)}
                  aria-expanded={expanded}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-raised"
                >
                  <ChevronRight
                    aria-hidden
                    className={cn(
                      'h-3.5 w-3.5 shrink-0 text-content-faint transition-transform',
                      expanded && 'rotate-90',
                    )}
                  />

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[0.8125rem] font-semibold text-content">
                        {spec.label}
                      </span>
                      <span className="font-mono text-micro text-content-faint">
                        {formatCount(group.jobs.length)} {group.jobs.length === 1 ? 'job' : 'jobs'}
                      </span>
                    </div>
                    <p className="mt-0.5 text-micro text-content-muted">{spec.hint}</p>

                    {/* Share of the pending money, so the biggest lever is obvious. */}
                    <div className="mt-2 h-[3px] w-full max-w-xs overflow-hidden rounded-full bg-overlay">
                      <span
                        aria-hidden
                        className={cn('block h-full rounded-full', TONE_CLASSES[spec.tone].dot)}
                        style={{ width: `${Math.max(share * 100, 1.5)}%` }}
                      />
                    </div>
                  </div>

                  <div className="shrink-0 text-right">
                    <p className="font-mono text-data-sm text-content">
                      {formatINRCompact(group.amountPaise)}
                    </p>
                    <p className="mt-0.5 font-mono text-micro text-content-faint">
                      {formatPercent(group.confidence, 0)} avg confidence
                    </p>
                  </div>
                </button>

                {expanded ? (
                  <div className="animate-fade-rise border-t border-hairline bg-canvas/40">
                    <ul className="divide-hairline-y">
                      {group.jobs.map((job) => (
                        <li key={job.id} className="px-4 py-3 pl-[1.9375rem]">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0">
                              <button
                                type="button"
                                onClick={() => onOpenJob(job)}
                                className="text-[0.8125rem] font-medium text-content hover:text-azure-soft"
                              >
                                {job.payment.customer.name}
                              </button>
                              <div className="mt-1 flex flex-wrap items-center gap-2">
                                <Money
                                  paise={job.payment.amountPaise}
                                  variant="exact"
                                  className="text-micro text-content-muted"
                                />
                                <ReasonBadge reason={job.payment.failureReason} />
                                <ChannelTag channel={job.recommendedAction.channel} />
                                <span className="font-mono text-micro text-content-faint">
                                  {job.nextActionAt
                                    ? `fires ${formatRelative(job.nextActionAt)}`
                                    : 'unscheduled'}
                                </span>
                              </div>
                            </div>

                            <div className="flex shrink-0 items-center gap-1.5">
                              <Button
                                size="sm"
                                variant="primary"
                                busy={pendingId === job.id}
                                onClick={() => onApprove(job)}
                              >
                                Approve
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={pendingId === job.id}
                                onClick={() => onSuppress(job)}
                              >
                                Skip
                              </Button>
                            </div>
                          </div>

                          <div className="mt-3 rounded-panel border border-hairline bg-raised p-3">
                            <div className="mb-2.5 flex items-center justify-between gap-2">
                              <h4 className="eyebrow">Why this action</h4>
                              <ActionBadge kind={job.recommendedAction.kind} />
                            </div>
                            <SignalList signals={job.recommendedAction.signals} />
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function groupByAction(jobs: RecoveryJob[]): Group[] {
  const byKind = new Map<RecoveryActionKind, RecoveryJob[]>();

  for (const job of jobs) {
    const bucket = byKind.get(job.recommendedAction.kind);
    if (bucket) bucket.push(job);
    else byKind.set(job.recommendedAction.kind, [job]);
  }

  return [...byKind.entries()]
    .map(([kind, grouped]) => ({
      kind,
      jobs: [...grouped].sort((a, b) => b.payment.amountPaise - a.payment.amountPaise),
      amountPaise: grouped.reduce((sum, job) => sum + job.payment.amountPaise, 0),
      confidence:
        grouped.reduce((sum, job) => sum + job.recommendedAction.confidence, 0) / grouped.length,
    }))
    .sort((a, b) => b.amountPaise - a.amountPaise);
}
