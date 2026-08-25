import { AlertTriangle } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import type { FailureBreakdown, MethodBreakdown } from '@/domain';
import { FAILURE_REASONS, PAYMENT_METHODS } from '@/domain';
import { data } from '@/data';
import { useQuery } from '@/hooks/useQuery';
import { PageHeader } from '@/components/layout';
import {
  Button,
  Callout,
  DataTable,
  Meter,
  Panel,
  PanelBody,
  PanelHeader,
  SegmentedControl,
  Skeleton,
  type Column,
} from '@/components/ui';
import { Money, ReasonBadge } from '@/components/domain';
import {
  AttemptYieldChart,
  CHART_COLORS,
  FailureReasonChart,
  MethodRecoveryChart,
} from '@/components/charts';
import { formatCount, formatINRCompact, formatPercent } from '@/lib/format';

const WINDOW_OPTIONS = [
  { value: 7, label: '7D' },
  { value: 14, label: '14D' },
  { value: 30, label: '30D' },
];

/** Below this yield an extra retry costs more in gateway fees than it returns. */
const RETRY_YIELD_FLOOR = 0.08;

/**
 * Analytics. Three questions, in the order a payments lead asks them: why are
 * payments failing, which rails recover, and how many retries are worth paying
 * for. Each panel states the conclusion in words above the chart, because a
 * chart nobody can summarise is decoration.
 */
export function AnalyticsPage() {
  const [windowDays, setWindowDays] = useState(30);

  const reasons = useQuery(() => data.metrics.getFailureBreakdown(windowDays), [windowDays]);
  const methods = useQuery(() => data.metrics.getMethodBreakdown(windowDays), [windowDays]);
  const attempts = useQuery(() => data.metrics.getAttemptEffectiveness(windowDays), [windowDays]);

  const reasonRows = useMemo(
    () => [...(reasons.data ?? [])].sort((a, b) => b.atRiskPaise - a.atRiskPaise),
    [reasons.data],
  );
  const methodRows = useMemo(
    () => [...(methods.data ?? [])].sort((a, b) => b.atRiskPaise - a.atRiskPaise),
    [methods.data],
  );
  const attemptRows = useMemo(() => attempts.data ?? [], [attempts.data]);

  const worstReason = reasonRows[0];
  const bestMethod = useMemo(
    () => [...methodRows].sort((a, b) => b.recoveryRate - a.recoveryRate)[0],
    [methodRows],
  );
  const lastWorthwhileAttempt = useMemo(() => {
    const worthwhile = attemptRows.filter((row) => row.recoveryRate >= RETRY_YIELD_FLOOR);
    return worthwhile.length > 0 ? worthwhile[worthwhile.length - 1] : undefined;
  }, [attemptRows]);

  const error = reasons.error ?? methods.error ?? attempts.error;

  return (
    <>
      <PageHeader
        title="Analytics"
        description="Why payments fail, which rails win the money back, and where retrying stops paying."
        actions={
          <SegmentedControl
            label="Time window"
            options={WINDOW_OPTIONS}
            value={windowDays}
            onChange={setWindowDays}
          />
        }
      />

      {error ? (
        <Callout
          tone="coral"
          title="Could not load analytics"
          className="mb-4"
          actions={
            <Button
              size="sm"
              onClick={() => {
                reasons.refetch();
                methods.refetch();
                attempts.refetch();
              }}
            >
              Try again
            </Button>
          }
        >
          {error}
        </Callout>
      ) : null}

      <div className="space-y-4">
        <Panel>
          <PanelHeader
            eyebrow={`Last ${windowDays} days`}
            title="Where the money leaks"
            description={
              worstReason
                ? `${FAILURE_REASONS[worstReason.reason].label} holds the most value at risk — ${formatINRCompact(
                    worstReason.atRiskPaise,
                  )} across ${formatCount(worstReason.jobCount)} jobs, recovering at ${formatPercent(
                    worstReason.recoveryRate,
                    0,
                  )}.`
                : 'Failed volume grouped by the reason the gateway gave'
            }
          />
          <div className="grid grid-cols-1 xl:grid-cols-2">
            <PanelBody className="border-hairline border-b xl:border-b-0 xl:border-r">
              {reasons.loading ? (
                <Skeleton className="h-[260px] w-full" />
              ) : (
                <FailureReasonChart rows={reasonRows} />
              )}
            </PanelBody>
            <div className="min-w-0">
              <DataTable
                columns={REASON_COLUMNS}
                rows={reasonRows}
                getRowId={(row) => row.reason}
                loading={reasons.loading}
                density="compact"
                empty={<TableEmpty>No failures recorded in the last {windowDays} days.</TableEmpty>}
              />
            </div>
          </div>
        </Panel>

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <Panel>
            <PanelHeader
              eyebrow="By payment rail"
              title="Recovery by method"
              description={
                bestMethod
                  ? `${PAYMENT_METHODS[bestMethod.method].label} recovers best at ${formatPercent(
                      bestMethod.recoveryRate,
                      0,
                    )} — worth offering as the fallback rail.`
                  : 'Recovered against still-at-risk value per rail'
              }
            />
            <PanelBody>
              {methods.loading ? (
                <Skeleton className="h-[240px] w-full" />
              ) : (
                <MethodRecoveryChart rows={methodRows} />
              )}
              <ul className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t border-hairline pt-3">
                <Legend color={CHART_COLORS.recovered} label="Recovered" />
                <Legend color={CHART_COLORS.atRisk} label="Still at risk" />
              </ul>
            </PanelBody>
            <div className="border-t border-hairline">
              <DataTable
                columns={METHOD_COLUMNS}
                rows={methodRows}
                getRowId={(row) => row.method}
                loading={methods.loading}
                density="compact"
                empty={<TableEmpty>No payments on any rail in the last {windowDays} days.</TableEmpty>}
              />
            </div>
          </Panel>

          <Panel>
            <PanelHeader
              eyebrow="Retry economics"
              title="Yield per attempt"
              description="Each successive retry recovers less. This is where the retry budget should stop."
            />
            <PanelBody>
              {attempts.loading ? (
                <Skeleton className="h-[240px] w-full" />
              ) : (
                <AttemptYieldChart rows={attemptRows} />
              )}

              {lastWorthwhileAttempt ? (
                <Callout
                  tone="amber"
                  title={`Stop after attempt ${lastWorthwhileAttempt.attempt}`}
                  className="mt-3"
                >
                  Attempt {lastWorthwhileAttempt.attempt} still returns{' '}
                  {formatPercent(lastWorthwhileAttempt.recoveryRate, 0)}. Anything past it recovers
                  under {formatPercent(RETRY_YIELD_FLOOR, 0)}, which is below the gateway fee on a
                  typical charge — the attempt costs more than it brings back.
                </Callout>
              ) : attempts.loading ? null : (
                <Callout tone="neutral" title="Not enough retry history yet" className="mt-3">
                  Yield per attempt needs a few cycles of data before it can recommend a cap.
                </Callout>
              )}
            </PanelBody>
          </Panel>
        </div>

        <Panel>
          <PanelHeader
            eyebrow="Method note"
            title="How these numbers are computed"
            description="Every figure on this page is derived from your own recovery jobs"
          />
          <PanelBody className="max-w-3xl space-y-2 text-xs leading-relaxed text-content-muted">
            <p>
              Recovery rate is recovered value divided by total failed value in the window, not a
              count of jobs — one recovered subscription renewal is worth more than ten recovered
              small carts, and the rate reflects that.
            </p>
            <p>
              Yield per attempt counts each retry position independently: attempt 3 is measured only
              against jobs that actually reached a third attempt, so a low yield there is a
              statement about hard failures, not about volume.
            </p>
            <p className="flex items-start gap-2 text-content-faint">
              <AlertTriangle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Figures come from the local recovery store. Until Razorpay Test Mode credentials are
              configured, that store is seeded with a representative dataset rather than live
              settlement data.
            </p>
          </PanelBody>
        </Panel>
      </div>
    </>
  );
}

const REASON_COLUMNS: Column<FailureBreakdown>[] = [
  {
    id: 'reason',
    header: 'Reason',
    cell: (row) => <ReasonBadge reason={row.reason} />,
  },
  {
    id: 'jobs',
    header: 'Jobs',
    align: 'right',
    cell: (row) => (
      <span className="font-mono text-data-sm text-content-muted">{formatCount(row.jobCount)}</span>
    ),
  },
  {
    id: 'atRisk',
    header: 'At risk',
    align: 'right',
    cell: (row) => <Money paise={row.atRiskPaise} variant="compact" className="text-content" />,
  },
  {
    id: 'recovered',
    header: 'Recovered',
    align: 'right',
    hideBelow: 'md',
    cell: (row) => (
      <Money paise={row.recoveredPaise} variant="compact" className="text-mint-soft" />
    ),
  },
  {
    id: 'rate',
    header: 'Rate',
    width: 'w-[22%]',
    cell: (row) => (
      <Meter
        value={row.recoveryRate}
        tone={row.recoveryRate >= 0.5 ? 'mint' : row.recoveryRate >= 0.25 ? 'amber' : 'coral'}
        aria-label={`${FAILURE_REASONS[row.reason].label} recovery rate`}
      />
    ),
  },
];

const METHOD_COLUMNS: Column<MethodBreakdown>[] = [
  {
    id: 'method',
    header: 'Method',
    cell: (row) => <span className="text-content">{PAYMENT_METHODS[row.method].label}</span>,
  },
  {
    id: 'jobs',
    header: 'Jobs',
    align: 'right',
    cell: (row) => (
      <span className="font-mono text-data-sm text-content-muted">{formatCount(row.jobCount)}</span>
    ),
  },
  {
    id: 'atRisk',
    header: 'At risk',
    align: 'right',
    cell: (row) => <Money paise={row.atRiskPaise} variant="compact" className="text-content" />,
  },
  {
    id: 'rate',
    header: 'Rate',
    width: 'w-[26%]',
    cell: (row) => (
      <Meter
        value={row.recoveryRate}
        tone={row.recoveryRate >= 0.5 ? 'mint' : row.recoveryRate >= 0.25 ? 'amber' : 'coral'}
        aria-label={`${PAYMENT_METHODS[row.method].label} recovery rate`}
      />
    ),
  },
];

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <li className="flex items-center gap-1.5 text-micro text-content-muted">
      <span aria-hidden className="h-2 w-2 rounded-[2px]" style={{ backgroundColor: color }} />
      {label}
    </li>
  );
}

/** Keeps the panel the same height when a window has no rows in it. */
function TableEmpty({ children }: { children: ReactNode }) {
  return <p className="px-4 py-10 text-center text-xs text-content-faint">{children}</p>;
}
