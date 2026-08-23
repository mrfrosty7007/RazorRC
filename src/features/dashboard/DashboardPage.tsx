import { ArrowRight, IndianRupee, Percent, TrendingDown, Workflow } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { QueueFilters, RecoveryStatus } from '@/domain';
import { data } from '@/data';
import { useQuery } from '@/hooks/useQuery';
import { useAction } from '@/hooks/useAction';
import { PageHeader } from '@/components/layout';
import {
  Button,
  Callout,
  Panel,
  PanelBody,
  PanelHeader,
  SegmentedControl,
} from '@/components/ui';
import { KpiCard } from '@/components/domain';
import { CHART_COLORS, RecoveryTrendChart } from '@/components/charts';
import { RecoveryJobTable } from '@/features/queue/RecoveryJobTable';
import { JobDetailDrawer } from '@/features/queue/JobDetailDrawer';
import { RecoveryBand } from './RecoveryBand';
import { AiInsightPanel } from './AiInsightPanel';
import { RecoveryTimeline } from './RecoveryTimeline';
import { formatCount, formatINRCompact, formatPercent, formatPointDelta, formatSignedPercent } from '@/lib/format';

const WINDOW_OPTIONS = [
  { value: 7, label: '7D' },
  { value: 14, label: '14D' },
  { value: 30, label: '30D' },
];

const ACTIVE_STATUSES: RecoveryStatus[] = [
  'queued',
  'scheduled',
  'in_progress',
  'awaiting_customer',
];

/** Open jobs only. The dashboard never shows closed work. */
function openJobFilters(): QueueFilters {
  return {
    statuses: [...ACTIVE_STATUSES],
    reasons: [],
    methods: [],
    riskTiers: [],
    search: '',
  };
}

/**
 * The merchant dashboard. Ordered by the question a payments lead asks on
 * opening it: how much is at stake, how much came back, what is the engine
 * doing about the rest, and what happened while I was away.
 */
export function DashboardPage() {
  const navigate = useNavigate();
  const [windowDays, setWindowDays] = useState(14);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const metrics = useQuery(() => data.metrics.getDashboardMetrics(windowDays), [windowDays]);
  const trend = useQuery(() => data.metrics.getTrend(windowDays), [windowDays]);
  const insights = useQuery(() => data.insights.listInsights(), []);

  const priority = useQuery(
    () => data.recovery.listJobs(openJobFilters(), { offset: 0, limit: 6, sort: 'amount_desc' }),
    [],
  );

  const activity = useQuery(
    () => data.audit.listEvents({ offset: 0, limit: 14, severities: [], search: '' }),
    [],
  );

  // Read by id rather than kept as a snapshot of the clicked row: approving an
  // action changes the job's status, and a drawer still offering "Approve" on a
  // job that is already scheduled invites a duplicate charge.
  const detail = useQuery(
    () => (selectedId ? data.recovery.getJob(selectedId) : Promise.resolve(null)),
    [selectedId],
  );

  // Every panel on this page is downstream of the recovery store, so a write
  // has to refresh all of them. Leaving the trend or the insights out was the
  // subtler kind of stale: the KPI moved and the chart above it did not.
  const refreshAll = useCallback(() => {
    metrics.refetch();
    trend.refetch();
    insights.refetch();
    priority.refetch();
    activity.refetch();
    detail.refetch();
  }, [metrics, trend, insights, priority, activity, detail]);

  const [approve, approveState] = useAction(
    (jobId: string) => data.recovery.approveRecommendedAction(jobId),
    refreshAll,
  );
  const [retryNow, retryState] = useAction(
    (jobId: string) => data.recovery.retryNow(jobId),
    refreshAll,
  );
  const [suppress, suppressState] = useAction(
    (jobId: string) => data.recovery.suppressJob(jobId, 'Stopped from the dashboard'),
    refreshAll,
  );

  // The drawer shows one action at a time, so whichever write is in flight or
  // has just failed is the one to report. Dropping the retry and suppress
  // states made a rejected write look like a silent success.
  const actionPendingId =
    approveState.pendingId ?? retryState.pendingId ?? suppressState.pendingId;
  const actionError = approveState.error ?? retryState.error ?? suppressState.error;

  const series = useMemo(() => trend.data ?? [], [trend.data]);
  const kpi = metrics.data;
  const loading = metrics.loading;

  return (
    <>
      <PageHeader
        title="Merchant dashboard"
        description="Every rupee that failed to collect, and what is being done to get it back."
        actions={
          <SegmentedControl
            label="Time window"
            options={WINDOW_OPTIONS}
            value={windowDays}
            onChange={setWindowDays}
          />
        }
      />

      {metrics.error ? (
        <Callout
          tone="coral"
          title="Could not load your recovery metrics"
          className="mb-4"
          actions={
            <Button size="sm" onClick={metrics.refetch}>
              Try again
            </Button>
          }
        >
          {metrics.error}
        </Callout>
      ) : null}

      <div className="space-y-4">
        <RecoveryBand funnel={kpi?.funnel ?? null} windowDays={windowDays} loading={loading} />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard
            label="Revenue at risk"
            icon={TrendingDown}
            loading={loading}
            value={kpi ? formatINRCompact(kpi.revenueAtRiskPaise) : '—'}
            caption={kpi ? `across ${formatCount(kpi.activeJobs)} open jobs` : 'loading'}
            delta={
              kpi
                ? {
                    change: kpi.deltas.revenueAtRisk.change,
                    higherIsBetter: kpi.deltas.revenueAtRisk.higherIsBetter,
                    label: formatSignedPercent(kpi.deltas.revenueAtRisk.change),
                  }
                : undefined
            }
            trend={{ values: series.map((point) => point.atRiskPaise), color: CHART_COLORS.atRisk }}
          />

          <KpiCard
            label="Amount recovered"
            icon={IndianRupee}
            loading={loading}
            value={kpi ? formatINRCompact(kpi.recoveredPaise) : '—'}
            caption={`captured in the last ${windowDays} days`}
            delta={
              kpi
                ? {
                    change: kpi.deltas.recovered.change,
                    higherIsBetter: kpi.deltas.recovered.higherIsBetter,
                    label: formatSignedPercent(kpi.deltas.recovered.change),
                  }
                : undefined
            }
            trend={{
              values: series.map((point) => point.recoveredPaise),
              color: CHART_COLORS.recovered,
            }}
          />

          <KpiCard
            label="Recovery rate"
            icon={Percent}
            loading={loading}
            value={kpi ? formatPercent(kpi.recoveryRate) : '—'}
            caption="of failed volume collected"
            delta={
              kpi
                ? {
                    change: kpi.deltas.recoveryRate.change,
                    higherIsBetter: kpi.deltas.recoveryRate.higherIsBetter,
                    label: formatPointDelta(kpi.deltas.recoveryRate.change),
                  }
                : undefined
            }
            trend={{ values: series.map((point) => point.recoveryRate), color: CHART_COLORS.rate }}
          />

          <KpiCard
            label="Active recovery jobs"
            icon={Workflow}
            loading={loading}
            value={kpi ? formatCount(kpi.activeJobs) : '—'}
            caption="queued, scheduled or awaiting a customer"
            delta={
              kpi
                ? {
                    change: kpi.deltas.activeJobs.change,
                    higherIsBetter: kpi.deltas.activeJobs.higherIsBetter,
                    label: formatSignedPercent(kpi.deltas.activeJobs.change),
                  }
                : undefined
            }
            trend={{ values: series.map((point) => point.attempts), color: CHART_COLORS.engine }}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
          <Panel className="xl:col-span-2">
            <PanelHeader
              eyebrow={`Last ${windowDays} days`}
              title="Recovery trend"
              description="Failed volume against what came back, with the daily recovery rate"
            />
            <PanelBody>
              <RecoveryTrendChart points={series} />
              <ul className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t border-hairline pt-3">
                <LegendItem color={CHART_COLORS.atRisk} label="Failed volume" />
                <LegendItem color={CHART_COLORS.recovered} label="Recovered" />
                <LegendItem color={CHART_COLORS.rate} label="Recovery rate (right axis)" dashed />
              </ul>
            </PanelBody>
          </Panel>

          <AiInsightPanel
            insights={insights.data ?? []}
            loading={insights.loading}
            onOpenCopilot={() => navigate('/copilot')}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
          <Panel className="xl:col-span-2">
            <PanelHeader
              eyebrow="Highest value first"
              title="Recovery queue"
              description="Open jobs with the most money on the line"
              actions={
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => navigate('/queue')}
                  icon={<ArrowRight className="h-3.5 w-3.5" />}
                >
                  Open queue
                </Button>
              }
            />
            <RecoveryJobTable
              jobs={priority.data?.rows ?? []}
              loading={priority.loading}
              variant="compact"
              onSelect={(job) => setSelectedId(job.id)}
              activeJobId={selectedId}
            />
          </Panel>

          <RecoveryTimeline
            events={activity.data?.rows ?? []}
            loading={activity.loading}
            onOpenAudit={() => navigate('/audit')}
          />
        </div>
      </div>

      <JobDetailDrawer
        job={detail.data}
        onClose={() => setSelectedId(null)}
        pendingId={actionPendingId}
        error={actionError}
        onApprove={(job) => void approve(job.id, job.id)}
        onRetryNow={(job) => void retryNow(job.id, job.id)}
        onSuppress={(job) => void suppress(job.id, job.id)}
      />
    </>
  );
}

function LegendItem({
  color,
  label,
  dashed = false,
}: {
  color: string;
  label: string;
  dashed?: boolean;
}) {
  return (
    <li className="flex items-center gap-1.5 text-micro text-content-muted">
      <span
        aria-hidden
        className="h-0.5 w-4 rounded-full"
        style={
          dashed
            ? { backgroundImage: `repeating-linear-gradient(90deg, ${color} 0 3px, transparent 3px 6px)` }
            : { backgroundColor: color }
        }
      />
      {label}
    </li>
  );
}
