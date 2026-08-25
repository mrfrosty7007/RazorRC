import { Download, RefreshCw } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import type { AuditSeverity, RecoveryJob } from '@/domain';
import { AUDIT_SEVERITIES } from '@/domain';
import { data } from '@/data';
import { useQuery } from '@/hooks/useQuery';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { PageHeader } from '@/components/layout';
import {
  Button,
  Callout,
  FilterMenu,
  Pagination,
  Panel,
  PanelFooter,
  SearchInput,
  type FilterOption,
} from '@/components/ui';
import { JobDetailDrawer } from '@/features/queue/JobDetailDrawer';
import { AuditEventList } from './AuditEventList';
import { toCsv } from '@/lib/csv';
import { formatCount } from '@/lib/format';

const PAGE_SIZE = 30;

const SEVERITY_ORDER: AuditSeverity[] = ['critical', 'warning', 'notice', 'info'];

const SEVERITY_OPTIONS: FilterOption<AuditSeverity>[] = SEVERITY_ORDER.map((value) => ({
  value,
  label: AUDIT_SEVERITIES[value].label,
}));

/**
 * Audit trail.
 *
 * An automated system that moves a merchant's money needs a record a human can
 * interrogate afterwards, so this page is append-only, filterable and exportable
 * — never editable. Every engine decision, webhook and manual override lands
 * here with the context that produced it.
 */
export function AuditTrailPage() {
  const [severities, setSeverities] = useState<AuditSeverity[]>([]);
  const [searchDraft, setSearchDraft] = useState('');
  const [offset, setOffset] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [job, setJob] = useState<RecoveryJob | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);

  const search = useDebouncedValue(searchDraft, 250);

  const query = useMemo(
    () => ({ offset, limit: PAGE_SIZE, severities, search }),
    [offset, severities, search],
  );

  const page = useQuery(() => data.audit.listEvents(query), [query]);

  const changeSeverities = useCallback((next: AuditSeverity[]) => {
    setSeverities(next);
    setOffset(0);
  }, []);

  const changeSearch = useCallback((value: string) => {
    setSearchDraft(value);
    setOffset(0);
  }, []);

  // Clicking through from an event can miss: the trail keeps records of jobs
  // that may since have been purged, and a click that does nothing at all reads
  // as a broken link rather than as a missing job.
  const openJob = useCallback(async (jobId: string) => {
    setJobError(null);
    try {
      const found = await data.recovery.getJob(jobId);
      if (found) setJob(found);
      else setJobError(`Job ${jobId} is no longer in the recovery store. The event below is still its record.`);
    } catch (cause: unknown) {
      setJobError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const rows = useMemo(() => page.data?.rows ?? [], [page.data?.rows]);
  const total = page.data?.total ?? 0;

  /**
   * Export covers the rows currently in view rather than the whole trail: an
   * export that silently differs from what is on screen is a support ticket.
   */
  const exportCsv = useCallback(() => {
    const header = ['recorded_at', 'severity', 'actor_type', 'actor_name', 'action', 'summary', 'job_id'];
    const body = rows.map((event) => [
      event.at,
      event.severity,
      event.actor.type,
      event.actor.name,
      event.action,
      event.summary,
      event.jobId ?? '',
    ]);

    const blob = new Blob([toCsv(header, body)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `razorrc-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    // The anchor has to be in the document for the click to count as a user
    // download, and the URL has to outlive the click — revoking it in the same
    // tick cancels the write in some WebView builds.
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [rows]);

  return (
    <>
      <PageHeader
        title="Audit trail"
        description="Append-only record of every decision, message and override — engine and human alike."
        actions={
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={exportCsv}
              disabled={rows.length === 0}
              icon={<Download className="h-3.5 w-3.5" />}
            >
              Export view
            </Button>
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
          title="Could not load the audit trail"
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

      {jobError ? (
        <Callout tone="amber" title="Could not open that job" className="mb-4">
          {jobError}
        </Callout>
      ) : null}

      <Panel>
        <div className="flex flex-wrap items-center gap-2 border-b border-hairline p-4">
          <SearchInput
            value={searchDraft}
            onChange={changeSearch}
            placeholder="Search summary, action or actor"
            className="min-w-[16rem] flex-1"
          />
          <FilterMenu
            label="Severity"
            options={SEVERITY_OPTIONS}
            selected={severities}
            onChange={changeSeverities}
            className="w-48"
          />
          <p className="ml-auto font-mono text-micro text-content-faint">
            {page.loading ? 'Counting…' : `${formatCount(total)} events`}
          </p>
        </div>

        <AuditEventList
          events={rows}
          loading={page.loading}
          expandedId={expandedId}
          onToggle={(eventId) => setExpandedId((current) => (current === eventId ? null : eventId))}
          onOpenJob={(jobId) => void openJob(jobId)}
          highlight={search}
        />

        {total > 0 ? (
          <PanelFooter>
            <Pagination
              offset={offset}
              limit={PAGE_SIZE}
              total={total}
              onOffsetChange={setOffset}
              noun="events"
            />
          </PanelFooter>
        ) : null}
      </Panel>

      <JobDetailDrawer job={job} onClose={() => setJob(null)} readOnly />
    </>
  );
}
