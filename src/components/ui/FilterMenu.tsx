import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';

export interface FilterOption<T extends string> {
  value: T;
  label: string;
}

interface FilterMenuProps<T extends string> {
  label: string;
  options: FilterOption<T>[];
  selected: T[];
  onChange: (selected: T[]) => void;
  className?: string;
}

/**
 * Multi-select popover. Closed label states the current selection rather than
 * a count alone, so the active filter is readable without opening it.
 */
export function FilterMenu<T extends string>({
  label,
  options,
  selected,
  onChange,
  className,
}: FilterMenuProps<T>) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  function toggle(value: T) {
    onChange(
      selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value],
    );
  }

  const summary =
    selected.length === 0
      ? 'All'
      : selected.length === 1
        ? (options.find((option) => option.value === selected[0])?.label ?? '1 selected')
        : `${selected.length} selected`;

  return (
    <div ref={container} className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className={cn(
          'inline-flex h-[2.125rem] w-full items-center justify-between gap-2 rounded-control border px-2.5',
          'text-[0.8125rem] transition-colors duration-150',
          selected.length > 0
            ? 'border-azure/50 bg-azure-dim text-content'
            : 'border-hairline bg-surface text-content-muted hover:border-hairline-strong',
        )}
      >
        <span className="truncate">
          <span className="text-content-faint">{label}</span>
          <span className="mx-1.5 text-content-faint">·</span>
          {summary}
        </span>
        <ChevronDown
          aria-hidden
          className={cn('h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-180')}
        />
      </button>

      {open ? (
        <div
          role="listbox"
          aria-multiselectable
          className="absolute left-0 top-[calc(100%+4px)] z-30 max-h-72 w-56 animate-fade-rise overflow-y-auto rounded-panel border border-hairline-strong bg-raised p-1 shadow-lift"
        >
          {selected.length > 0 ? (
            <button
              type="button"
              onClick={() => onChange([])}
              className="mb-1 w-full rounded-[0.25rem] px-2 py-1.5 text-left text-xs text-content-muted hover:bg-overlay hover:text-content"
            >
              Clear {label.toLowerCase()}
            </button>
          ) : null}

          {options.map((option) => {
            const isSelected = selected.includes(option.value);
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => toggle(option.value)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-[0.25rem] px-2 py-1.5 text-left text-[0.8125rem]',
                  isSelected ? 'text-content' : 'text-content-muted',
                  'hover:bg-overlay',
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border',
                    isSelected ? 'border-azure bg-azure text-white' : 'border-hairline-strong',
                  )}
                >
                  {isSelected ? <Check className="h-2.5 w-2.5" strokeWidth={3} /> : null}
                </span>
                <span className="truncate">{option.label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
