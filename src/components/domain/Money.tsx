import { cn } from '@/lib/cn';
import { formatINR, formatINRCompact, formatINRExact } from '@/lib/format';

interface MoneyProps {
  paise: number;
  /**
   * `exact` for a single transaction, `full` for grouped totals,
   * `compact` for tiles and axis labels.
   */
  variant?: 'exact' | 'full' | 'compact';
  className?: string;
}

/** Every rupee figure in the app renders through here. */
export function Money({ paise, variant = 'full', className }: MoneyProps) {
  const text =
    variant === 'exact'
      ? formatINRExact(paise)
      : variant === 'compact'
        ? formatINRCompact(paise)
        : formatINR(paise);

  return (
    <span
      className={cn('font-mono tabular-nums', className)}
      title={variant === 'compact' ? formatINRExact(paise) : undefined}
      data-selectable
    >
      {text}
    </span>
  );
}
