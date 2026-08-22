import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Skeleton, TrendChip } from '@/components/ui';
import { Sparkline } from '@/components/charts';

interface KpiCardProps {
  label: string;
  /** The headline figure, already formatted. Rendered in the mono ledger face. */
  value: ReactNode;
  /** Comparison against the previous equivalent window. */
  delta?: { change: number; higherIsBetter: boolean; label: string };
  /** Plain sentence stating what the number counts. */
  caption: string;
  icon: LucideIcon;
  trend?: { values: number[]; color: string };
  loading?: boolean;
  className?: string;
}

/**
 * One number, its direction, and what it means. The value uses the mono face at
 * display size: these are ledger figures and they should read like a statement,
 * not like marketing copy.
 */
export function KpiCard({
  label,
  value,
  delta,
  caption,
  icon: Icon,
  trend,
  loading = false,
  className,
}: KpiCardProps) {
  return (
    <article className={cn('panel flex flex-col justify-between p-4', className)}>
      <div className="flex items-start justify-between gap-3">
        <p className="eyebrow">{label}</p>
        <Icon aria-hidden className="h-3.5 w-3.5 shrink-0 text-content-faint" strokeWidth={1.75} />
      </div>

      <div className="mt-3">
        {loading ? (
          <Skeleton className="h-8 w-28" />
        ) : (
          <p className="font-mono text-data-lg font-medium text-content">{value}</p>
        )}

        <div className="mt-1.5 flex items-center gap-2">
          {delta && !loading ? (
            <TrendChip
              change={delta.change}
              higherIsBetter={delta.higherIsBetter}
              label={delta.label}
            />
          ) : null}
          <p className="truncate text-micro text-content-faint">{caption}</p>
        </div>
      </div>

      {trend ? (
        <div className="-mx-1 mt-3">
          <Sparkline values={trend.values} color={trend.color} />
        </div>
      ) : null}
    </article>
  );
}
