import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Leading icon element, sized by the caller to 14px. */
  icon?: ReactNode;
  /** Shows a spinner and blocks input. */
  busy?: boolean;
}

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-azure text-white hover:bg-azure-soft active:bg-azure-deep border border-azure/60 shadow-panel',
  secondary:
    'bg-raised text-content hover:bg-overlay border border-hairline-strong hover:border-hairline-strong',
  ghost: 'bg-transparent text-content-muted hover:text-content hover:bg-raised border border-transparent',
  danger: 'bg-coral-dim text-coral-soft hover:bg-coral/25 border border-coral/40',
};

const SIZES: Record<Size, string> = {
  sm: 'h-7 gap-1.5 rounded-control px-2 text-xs',
  md: 'h-[2.125rem] gap-2 rounded-control px-3 text-[0.8125rem]',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, busy = false, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={rest.type ?? 'button'}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cn(
        'inline-flex select-none items-center justify-center font-medium transition-colors duration-150',
        'disabled:cursor-not-allowed disabled:opacity-45',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {busy ? <Spinner /> : icon}
      {children}
    </button>
  );
});

function Spinner() {
  return (
    <span
      aria-hidden
      className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent"
    />
  );
}
