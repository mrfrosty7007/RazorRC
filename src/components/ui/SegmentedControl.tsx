import { cn } from '@/lib/cn';

interface SegmentedControlProps<T extends string | number> {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  className?: string;
}

/** Mutually exclusive choice, used for the dashboard time window. */
export function SegmentedControl<T extends string | number>({
  options,
  value,
  onChange,
  label,
  className,
}: SegmentedControlProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        'inline-flex items-center gap-0.5 rounded-control border border-hairline bg-surface p-0.5',
        className,
      )}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              'rounded-[0.25rem] px-2 py-1 font-mono text-micro font-medium transition-colors duration-100',
              selected
                ? 'bg-raised text-content shadow-panel'
                : 'text-content-faint hover:text-content-muted',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
