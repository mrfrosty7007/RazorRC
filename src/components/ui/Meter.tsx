import { cn } from '@/lib/cn';
import { TONE_CLASSES, type Tone } from '@/domain';
import { formatPercent } from '@/lib/format';

interface MeterProps {
  /** 0..1. Values outside the range are clamped. */
  value: number;
  tone?: Tone;
  showLabel?: boolean;
  className?: string;
  'aria-label'?: string;
}

/** Thin proportion bar for rates inside table cells. */
export function Meter({
  value,
  tone = 'azure',
  showLabel = true,
  className,
  'aria-label': ariaLabel,
}: MeterProps) {
  const clamped = Math.min(1, Math.max(0, value));

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div
        role="meter"
        aria-valuenow={Math.round(clamped * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={ariaLabel ?? 'Rate'}
        className="h-1 w-full min-w-[3rem] overflow-hidden rounded-full bg-overlay"
      >
        <div
          className={cn('h-full rounded-full', TONE_CLASSES[tone].dot)}
          style={{ width: `${clamped * 100}%` }}
        />
      </div>
      {showLabel ? (
        <span className="w-11 shrink-0 text-right font-mono text-micro text-content-muted">
          {formatPercent(clamped, 0)}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Recovery score as ten discrete ticks. Segments rather than a smooth bar,
 * because the score is a probability estimate and shouldn't imply more
 * precision than it has.
 */
export function ScoreTicks({ value, className }: { value: number; className?: string }) {
  const filled = Math.round(Math.min(1, Math.max(0, value)) * 10);
  const tone: Tone = value >= 0.66 ? 'mint' : value >= 0.4 ? 'amber' : 'coral';

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div className="flex items-center gap-[2px]" aria-hidden>
        {Array.from({ length: 10 }, (_, index) => (
          <span
            key={index}
            className={cn(
              'h-3 w-[3px] rounded-full',
              index < filled ? TONE_CLASSES[tone].dot : 'bg-overlay',
            )}
          />
        ))}
      </div>
      <span className={cn('font-mono text-data-sm', TONE_CLASSES[tone].text)}>
        {formatPercent(value, 0)}
      </span>
    </div>
  );
}
