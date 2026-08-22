import type { RecoveryFunnel } from '@/domain';
import { FUNNEL_STAGES, TONE_CLASSES } from '@/domain';
import { cn } from '@/lib/cn';
import { Money } from '@/components/domain';
import { Skeleton } from '@/components/ui';
import { formatCount, formatPercent } from '@/lib/format';

interface RecoveryBandProps {
  funnel: RecoveryFunnel | null;
  windowDays: number;
  loading?: boolean;
}

/**
 * Money in motion.
 *
 * One continuous band showing where every at-risk rupee in the window currently
 * sits, sized by amount rather than by count -- a hundred ₹299 subscriptions
 * matter less than three ₹80,000 orders, and a chart that counts rows hides
 * that. This is the first thing on the dashboard because it is the only view
 * that answers "how much of this have we actually got back" in one glance.
 */
export function RecoveryBand({ funnel, windowDays, loading = false }: RecoveryBandProps) {
  if (loading || !funnel) {
    return (
      <section className="panel p-4">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="mt-3 h-9 w-full" />
        <Skeleton className="mt-4 h-10 w-full" />
      </section>
    );
  }

  const segments = funnel.segments.filter((segment) => segment.amountPaise > 0);
  const total = funnel.totalPaise;
  const recovered = segments.find((segment) => segment.stage === 'recovered');
  const recoveredShare = total === 0 ? 0 : (recovered?.amountPaise ?? 0) / total;

  return (
    <section className="panel p-4" aria-label="Money in motion">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div>
          <p className="eyebrow">Money in motion · last {windowDays} days</p>
          <p className="mt-1.5 font-mono text-data-xl font-medium tracking-tight text-content">
            <Money paise={total} />
          </p>
        </div>
        <p className="text-xs text-content-muted">
          <span className="font-mono text-mint">{formatPercent(recoveredShare, 1)}</span> of failed
          volume recovered so far
        </p>
      </div>

      {/* The band itself: width is money, not row count. */}
      <div className="mt-4 flex h-9 w-full overflow-hidden rounded-control border border-hairline bg-canvas">
        {segments.map((segment, index) => {
          const share = total === 0 ? 0 : segment.amountPaise / total;
          const spec = FUNNEL_STAGES[segment.stage];

          return (
            <div
              key={segment.stage}
              title={`${spec.label}: ${formatCount(segment.jobCount)} jobs`}
              style={{
                width: `${share * 100}%`,
                transformOrigin: 'left',
                animationDelay: `${index * 70}ms`,
              }}
              className={cn(
                'flex animate-band-grow items-center overflow-hidden border-r border-canvas/60 px-2 last:border-r-0',
                TONE_CLASSES[spec.tone].dot,
              )}
            >
              {share > 0.12 ? (
                <span className="truncate font-mono text-micro font-semibold text-canvas/85">
                  {formatPercent(share, 0)}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>

      <dl className="mt-3.5 grid grid-cols-2 gap-x-6 gap-y-2.5 sm:grid-cols-3 lg:grid-cols-5">
        {funnel.segments.map((segment) => {
          const spec = FUNNEL_STAGES[segment.stage];
          return (
            <div key={segment.stage} className="min-w-0">
              <dt className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className={cn('h-1.5 w-1.5 shrink-0 rounded-full', TONE_CLASSES[spec.tone].dot)}
                />
                <span className="truncate text-micro text-content-muted" title={spec.hint}>
                  {spec.label}
                </span>
              </dt>
              <dd className="mt-1 pl-3">
                <Money paise={segment.amountPaise} variant="compact" className="text-data-sm text-content" />
                <span className="ml-1.5 font-mono text-micro text-content-faint">
                  {formatCount(segment.jobCount)} jobs
                </span>
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}
