import { cn } from '@/lib/cn';

interface TabsProps<T extends string> {
  tabs: { value: T; label: string; count?: number }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  className?: string;
}

/** Underlined tab bar for switching views within one page. */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  className,
}: TabsProps<T>) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn('flex items-center gap-1 border-b border-hairline', className)}
    >
      {tabs.map((tab) => {
        const selected = tab.value === value;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(tab.value)}
            className={cn(
              'relative -mb-px flex items-center gap-2 border-b-2 px-3 py-2.5 text-[0.8125rem] font-medium transition-colors',
              selected
                ? 'border-azure text-content'
                : 'border-transparent text-content-faint hover:text-content-muted',
            )}
          >
            {tab.label}
            {typeof tab.count === 'number' ? (
              <span
                className={cn(
                  'rounded-full px-1.5 py-px font-mono text-micro',
                  selected ? 'bg-azure-dim text-azure-soft' : 'bg-overlay text-content-faint',
                )}
              >
                {tab.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
