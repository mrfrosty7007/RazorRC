import { AlertTriangle, Info, ShieldAlert, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { TONE_CLASSES, type Tone } from '@/domain';

const ICONS: Partial<Record<Tone, typeof Info>> = {
  neutral: Info,
  azure: Info,
  amber: AlertTriangle,
  coral: ShieldAlert,
  violet: Sparkles,
};

interface CalloutProps {
  tone?: Tone;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

/**
 * Inline message. Used for failures and for stating a missing prerequisite --
 * it says what happened and what to do, never just "something went wrong".
 */
export function Callout({ tone = 'azure', title, children, actions, className }: CalloutProps) {
  const classes = TONE_CLASSES[tone];
  const Icon = ICONS[tone] ?? Info;

  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-panel border px-3.5 py-3',
        classes.bg,
        classes.border,
        className,
      )}
    >
      <Icon aria-hidden className={cn('mt-0.5 h-4 w-4 shrink-0', classes.text)} />
      <div className="min-w-0 flex-1">
        <p className={cn('text-[0.8125rem] font-semibold', classes.text)}>{title}</p>
        {children ? (
          <div className="mt-1 text-xs leading-relaxed text-content-muted">{children}</div>
        ) : null}
        {actions ? <div className="mt-2.5 flex items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}
