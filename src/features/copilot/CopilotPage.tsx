import { useCallback, useState } from 'react';
import type { Playbook, QueueFilters, RecoveryJob, RecoveryStatus } from '@/domain';
import { data } from '@/data';
import { useQuery } from '@/hooks/useQuery';
import { useAction } from '@/hooks/useAction';
import { PageHeader } from '@/components/layout';
import { Badge, Button, Callout } from '@/components/ui';
import { JobDetailDrawer } from '@/features/queue/JobDetailDrawer';
import { RecommendationQueue } from './RecommendationQueue';
import { PlaybookList } from './PlaybookList';
import { CopilotComposer } from './CopilotComposer';

/** Jobs the engine has an unapproved opinion about. */
const PENDING_STATUSES: RecoveryStatus[] = ['queued', 'awaiting_customer'];

function pendingFilters(): QueueFilters {
  return {
    statuses: [...PENDING_STATUSES],
    reasons: [],
    methods: [],
    riskTiers: [],
    search: '',
  };
}

/**
 * AI Copilot.
 *
 * The page is built around a distinction worth being pedantic about: the
 * recommendations and playbooks below are real, deterministic engine output that
 * works today, while the conversational panel is a genuine integration point
 * that is honestly switched off. Neither pretends to be the other.
 */
export function CopilotPage() {
  const [selected, setSelected] = useState<RecoveryJob | null>(null);

  const pending = useQuery(
    () => data.recovery.listJobs(pendingFilters(), { offset: 0, limit: 40, sort: 'amount_desc' }),
    [],
  );
  const playbooks = useQuery(() => data.playbooks.listPlaybooks(), []);

  const refreshAll = useCallback(() => {
    pending.refetch();
    playbooks.refetch();
  }, [pending, playbooks]);

  const [approve, approveState] = useAction(
    (jobId: string) => data.recovery.approveRecommendedAction(jobId),
    refreshAll,
  );
  const [retryNow] = useAction((jobId: string) => data.recovery.retryNow(jobId), refreshAll);
  const [suppress] = useAction(
    (jobId: string) => data.recovery.suppressJob(jobId, 'Skipped from the copilot'),
    refreshAll,
  );
  const [togglePlaybook, toggleState] = useAction(
    (playbookId: string, enabled: boolean) =>
      data.playbooks.setPlaybookEnabled(playbookId, enabled),
    playbooks.refetch,
  );

  const jobs = pending.data?.rows ?? [];

  return (
    <>
      <PageHeader
        title="AI Copilot"
        description="The engine's reasoning, the rules behind it, and the actions waiting on your approval."
        actions={
          <Badge tone="violet" dot>
            Rules engine v1
          </Badge>
        }
      />

      {pending.error ? (
        <Callout
          tone="coral"
          title="Could not load pending recommendations"
          className="mb-4"
          actions={
            <Button size="sm" onClick={pending.refetch}>
              Try again
            </Button>
          }
        >
          {pending.error}
        </Callout>
      ) : null}

      {approveState.error ? (
        <Callout
          tone="coral"
          title="That action could not be applied"
          className="mb-4"
          actions={
            <Button size="sm" variant="ghost" onClick={approveState.clearError}>
              Dismiss
            </Button>
          }
        >
          {approveState.error}
        </Callout>
      ) : null}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <RecommendationQueue
            jobs={jobs}
            loading={pending.loading}
            pendingId={approveState.pendingId}
            onApprove={(job) => void approve(job.id, job.id)}
            onSuppress={(job) => void suppress(job.id, job.id)}
            onOpenJob={setSelected}
          />

          <CopilotComposer scopedJobIds={jobs.map((job) => job.id)} />
        </div>

        <PlaybookList
          playbooks={playbooks.data ?? []}
          loading={playbooks.loading}
          pendingId={toggleState.pendingId}
          onToggle={(playbook: Playbook, enabled: boolean) =>
            void togglePlaybook(playbook.id, playbook.id, enabled)
          }
        />
      </div>

      <JobDetailDrawer
        job={selected}
        onClose={() => setSelected(null)}
        pendingId={approveState.pendingId}
        error={approveState.error}
        onApprove={(job) => void approve(job.id, job.id)}
        onRetryNow={(job) => void retryNow(job.id, job.id)}
        onSuppress={(job) => void suppress(job.id, job.id)}
      />
    </>
  );
}
