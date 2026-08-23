import { Inbox, RefreshCw } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { QueueFilters, RecoveryJob, RecoveryStatus } from '@/domain';
import { data } from '@/data';
import type { JobSort } from '@/data/repositories';
import { useQuery } from '@/hooks/useQuery';
import { useAction } from '@/hooks/useAction';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { PageHeader } from '@/components/layout';
import {
  Button,
  Callout,
  EmptyState,
  Pagination,
  Panel,
  PanelFooter,
  SegmentedControl,
  Tabs,
} from '@/components/ui';
import { QueueFilterBar } from './QueueFilterBar';
import { RecoveryJobTable } from './RecoveryJobTable';
import { JobDetailDrawer } from './JobDetailDrawer';

const PAGE_SIZE = 25;

const SORT_OPTIONS: { value: JobSort; label: string }[] = [
  { value: 'recent', label: 'NEWEST' },
  { value: 'amount_desc', label: 'AMOUNT' },
  { value: 'score_desc', label: 'SCORE' },
  { value: 'sla_soonest', label: 'DEADLINE' },
];

type ViewId = 'all' | 'needs_approval' | 'in_flight' | 'awaiting' | 'closed' | 'custom';

/**
 * Preset views over the same query. These are the four questions a merchant
 * actually opens this screen to answer; the filter row below is for everything
 * else. `custom` is never a tab -- it is what the tab bar reports when the
 * filters no longer match any preset.
 */
const VIEWS: { value: Exclude<ViewId, 'custom'>; label: string; statuses: RecoveryStatus[] }[] = [
  { value: 'all', label: 'All jobs', statuses: [] },
  { value: 'needs_approval', label: 'Needs approval', statuses: ['queued'] },
  { value: 'in_flight', label: 'In flight', statuses: ['scheduled', 'in_progress'] },
  { value: 'awaiting', label: 'Awaiting customer', statuses: ['awaiting_customer'] },
  {
    value: 'closed',
    label: 'Closed',
    statuses: ['recovered', 'failed', 'written_off', 'suppressed'],
  },
];

function emptyFilters(): QueueFilters {
  return { statuses: [], reasons: [], methods: [], riskTiers: [], search: '' };
}

function sameStatuses(a: RecoveryStatus[], b: RecoveryStatus[]): boolean {
  return a.length === b.length && [...a].sort().join() === [...b].sort().join();
}

/**
 * The working screen. A merchant lives here: filter down to a slice of failed
 * payments, open one, approve or stop what the engine wants to do next.
 *
 * Filtering, sorting and paging are all pushed to the data layer rather than
 * done on the loaded page, so the counts in the footer are true counts and the
 * same code path works when the rows come from SQLite through Rust.
 */
export function RecoveryQueuePage() {
  const [params, setParams] = useSearchParams();
  const [filters, setFilters] = useState<QueueFilters>(emptyFilters);
  const [searchDraft, setSearchDraft] = useState('');
  const [sort, setSort] = useState<JobSort>('amount_desc');
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(params.get('job'));

  const search = useDebouncedValue(searchDraft, 250);

  // Every filter change resets paging: page 3 of a different result set is meaningless.
  const applyFilters = useCallback((next: QueueFilters) => {
    setFilters(next);
    setOffset(0);
  }, []);

  const changeSearch = useCallback((value: string) => {
    setSearchDraft(value);
    setOffset(0);
  }, []);

  const effective = useMemo<QueueFilters>(() => ({ ...filters, search }), [filters, search]);

  const activeView = useMemo<ViewId>(
    () => VIEWS.find((view) => sameStatuses(view.statuses, filters.statuses))?.value ?? 'custom',
    [filters.statuses],
  );

  const selectView = useCallback(
    (value: ViewId) => {
      const view = VIEWS.find((candidate) => candidate.value === value);
      if (!view) return;
      applyFilters({ ...filters, statuses: [...view.statuses] });
    },
    [applyFilters, filters],
  );

  const page = useQuery(
    () => data.recovery.listJobs(effective, { offset, limit: PAGE_SIZE, sort }),
    [effective, offset, sort],
  );

  // Fetched by id rather than read out of the current page, so a `?job=` deep
  // link opens even when that row lives on another page or outside the filter.
  const detail = useQuery(
    () => (selectedId ? data.recovery.getJob(selectedId) : Promise.resolve(null)),
    [selectedId],
  );

  const openJob = useCallback(
    (job: RecoveryJob | null) => {
      setSelectedId(job?.id ?? null);
      // The deep link means a merchant can paste a queue row into a ticket.
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (job) next.set('job', job.id);
          else next.delete('job');
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const refreshAll = useCallback(() => {
    page.refetch();
    detail.refetch();
  }, [page, detail]);

  const [approve, approveState] = useAction(
    (jobId: string) => data.recovery.approveRecommendedAction(jobId),
    refreshAll,
  );
  const [retryNow, retryState] = useAction(
    (jobId: string) => data.recovery.retryNow(jobId),
    refreshAll,
  );
  const [suppress, suppressState] = useAction(
    (jobId: string) => data.recovery.suppressJob(jobId, 'Stopped from the recovery queue'),
    refreshAll,
  );

  // One drawer, three writes, one place to report them. Keeping only the
  // approve state meant a failed "Retry now" or "Stop automation" looked
  // exactly like a successful one.
  const actionPendingId =
    approveState.pendingId ?? retryState.pendingId ?? suppressState.pendingId;
  const actionError = approveState.error ?? retryState.error ?? suppressState.error;

  const total = page.data?.total ?? 0;
  const hasFilters =
    filters.statuses.length +
      filters.reasons.length +
      filters.methods.length +
      filters.riskTiers.length >
      0 || search.length > 0;

  return (
    <>
      <PageHeader
        title="Recovery queue"
        description="Every failed payment the engine is working, and what it plans to do next."
        actions={
          <>
            <SegmentedControl
              label="Sort jobs by"
              options={SORT_OPTIONS}
              value={sort}
              onChange={setSort}
            />
            <Button
              size="sm"
              variant="secondary"
              onClick={page.refetch}
              busy={page.refreshing}
              icon={<RefreshCw className="h-3.5 w-3.5" />}
            >
              Refresh
            </Button>
          </>
        }
      />

      {page.error ? (
        <Callout
          tone="coral"
          title="Could not load the recovery queue"
          className="mb-4"
          actions={
            <Button size="sm" onClick={page.refetch}>
              Try again
            </Button>
          }
        >
          {page.error}
        </Callout>
      ) : null}

      <Panel>
        <Tabs
          label="Queue views"
          tabs={VIEWS.map((view) => ({ value: view.value as ViewId, label: view.label }))}
          value={activeView}
          onChange={selectView}
          className="px-2 pt-1"
        />

        <QueueFilterBar
          filters={filters}
          searchDraft={searchDraft}
          onSearchDraftChange={changeSearch}
          onChange={applyFilters}
          onReset={() => {
            setSearchDraft('');
            applyFilters(emptyFilters());
          }}
          matchCount={page.loading ? null : total}
        />

        <RecoveryJobTable
          jobs={page.data?.rows ?? []}
          loading={page.loading}
          variant="full"
          onSelect={openJob}
          activeJobId={selectedId}
          empty={
            hasFilters ? (
              <EmptyState
                icon={Inbox}
                title="No jobs match these filters"
                description="Widen the filters, or clear them to see the whole queue."
                action={
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setSearchDraft('');
                      applyFilters(emptyFilters());
                    }}
                  >
                    Clear filters
                  </Button>
                }
              />
            ) : undefined
          }
        />

        {total > 0 ? (
          <PanelFooter>
            <Pagination
              offset={offset}
              limit={PAGE_SIZE}
              total={total}
              onOffsetChange={setOffset}
              noun="jobs"
            />
          </PanelFooter>
        ) : null}
      </Panel>

      <JobDetailDrawer
        job={detail.data}
        onClose={() => openJob(null)}
        pendingId={actionPendingId}
        error={actionError}
        onApprove={(job) => void approve(job.id, job.id)}
        onRetryNow={(job) => void retryNow(job.id, job.id)}
        onSuppress={(job) => void suppress(job.id, job.id)}
      />
    </>
  );
}
