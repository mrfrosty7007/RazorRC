import { cn } from '@/lib/cn';

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Describes what the switch controls, for screen readers. */
  label: string;
  disabled?: boolean;
  busy?: boolean;
  className?: string;
}

export function Toggle({ checked, onChange, label, disabled, busy, className }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-[1.125rem] w-8 shrink-0 items-center rounded-full border transition-colors duration-150',
        'disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'border-azure/60 bg-azure/70' : 'border-hairline-strong bg-overlay',
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          'ml-[2px] h-3 w-3 rounded-full bg-white transition-transform duration-150',
          checked ? 'translate-x-[0.875rem]' : 'translate-x-0',
          busy && 'animate-live-pulse',
        )}
      />
    </button>
  );
}
