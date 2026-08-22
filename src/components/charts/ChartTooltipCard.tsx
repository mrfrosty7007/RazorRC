import { cn } from '@/lib/cn';

export interface TooltipEntry {
  name?: string | number;
  value?: number | string | (number | string)[];
  color?: string;
  dataKey?: string | number;
}

export interface ChartTooltipCardProps {
  /** Injected by Recharts. */
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string | number;
  /** Formats each series value; receives the series `dataKey`. */
  formatValue?: (value: number, dataKey: string) => string;
  formatLabel?: (label: string | number) => string;
  className?: string;
}

/** Tooltip styled as a small panel, matching every other surface. */
export function ChartTooltipCard({
  active,
  payload,
  label,
  formatValue,
  formatLabel,
  className,
}: ChartTooltipCardProps) {
  if (!active || !payload || payload.length === 0) return null;

  return (
    <div
      className={cn(
        'min-w-[10rem] rounded-panel border border-hairline-strong bg-raised px-3 py-2 shadow-lift',
        className,
      )}
    >
      {label !== undefined ? (
        <p className="eyebrow mb-1.5">{formatLabel ? formatLabel(label) : String(label)}</p>
      ) : null}

      <ul className="space-y-1">
        {payload.map((entry, index) => {
          const raw = Array.isArray(entry.value) ? entry.value[0] : entry.value;
          const numeric = typeof raw === 'number' ? raw : Number(raw ?? 0);
          const key = String(entry.dataKey ?? index);

          return (
            <li key={key} className="flex items-center justify-between gap-4 text-xs">
              <span className="flex items-center gap-1.5 text-content-muted">
                <span
                  aria-hidden
                  className="h-2 w-2 rounded-[2px]"
                  style={{ backgroundColor: entry.color }}
                />
                {entry.name ?? key}
              </span>
              <span className="font-mono text-content">
                {formatValue ? formatValue(numeric, key) : numeric.toLocaleString('en-IN')}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
