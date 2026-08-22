import type { Signal } from '@/domain';
import { cn } from '@/lib/cn';

interface SignalListProps {
  signals: Signal[];
  className?: string;
}

/**
 * The engine's evidence, shown as signed contributions.
 *
 * Every recommendation in ReviveAI carries this list. A merchant who cannot see
 * why a retry was scheduled has no way to disagree with it, and an unarguable
 * recommendation is not a recommendation -- it is a black box moving money.
 */
export function SignalList({ signals, className }: SignalListProps) {
  const scale = Math.max(...signals.map((signal) => Math.abs(signal.weight)), 0.1);

  return (
    <ul className={cn('space-y-2.5', className)}>
      {signals.map((signal) => {
        const positive = signal.weight >= 0;
        const width = `${(Math.abs(signal.weight) / scale) * 50}%`;

        return (
          <li key={signal.label}>
            <div className="flex items-baseline justify-between gap-3">
              <p className="truncate text-xs font-medium text-content">{signal.label}</p>
              <span
                className={cn(
                  'shrink-0 font-mono text-micro',
                  positive ? 'text-mint' : 'text-coral',
                )}
              >
                {positive ? '+' : '−'}
                {Math.abs(signal.weight).toFixed(2)}
              </span>
            </div>

            {/* Centre line: gains extend right, penalties extend left. */}
            <div className="relative mt-1.5 h-[3px] w-full rounded-full bg-overlay">
              <span aria-hidden className="absolute left-1/2 top-[-2px] h-[7px] w-px bg-hairline-strong" />
              <span
                aria-hidden
                className={cn(
                  'absolute top-0 h-full rounded-full',
                  positive ? 'left-1/2 bg-mint' : 'right-1/2 bg-coral',
                )}
                style={{ width }}
              />
            </div>

            <p className="mt-1.5 text-micro leading-relaxed text-content-faint">{signal.detail}</p>
          </li>
        );
      })}
    </ul>
  );
}
