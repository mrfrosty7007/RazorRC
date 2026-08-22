import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { cn } from '@/lib/cn';
import { TONE_CLASSES } from '@/domain';

interface TrendChipProps {
  /** Fractional change against the comparison window. */
  change: number;
  /** Whether an increase is good news for this metric. */
  higherIsBetter: boolean;
  /** Pre-formatted change text, e.g. `+4.2pp`. */
  label: string;
  className?: string;
}

/**
 * Direction and judgement, separated. The arrow shows which way the number
 * moved; the colour shows whether that is good for this particular metric --
 * a fall in revenue at risk is green, a fall in recovery rate is not.
 */
export function TrendChip({ change, higherIsBetter, label, className }: TrendChipProps) {
  const flat = Math.abs(change) < 0.0005;
  const good = higherIsBetter ? change > 0 : change < 0;
  const tone = flat ? 'neutral' : good ? 'mint' : 'coral';
  const Icon = flat ? Minus : change > 0 ? ArrowUpRight : ArrowDownRight;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 font-mono text-micro font-medium',
        TONE_CLASSES[tone].text,
        className,
      )}
    >
      <Icon aria-hidden className="h-3 w-3" strokeWidth={2.25} />
      {label}
    </span>
  );
}
