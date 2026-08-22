import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

interface PanelProps {
  children: ReactNode;
  className?: string;
}

/** Flat bordered surface. Every block of content on every page sits in one. */
export function Panel({ children, className }: PanelProps) {
  return <section className={cn('panel', className)}>{children}</section>;
}

interface PanelHeaderProps {
  /** Micro-label above the title, e.g. "LAST 14 DAYS". */
  eyebrow?: string;
  title: string;
  /** One line of plain explanation under the title. */
  description?: string;
  actions?: ReactNode;
  className?: string;
}

export function PanelHeader({
  eyebrow,
  title,
  description,
  actions,
  className,
}: PanelHeaderProps) {
  return (
    <header className={cn('panel-header', className)}>
      <div className="min-w-0">
        {eyebrow ? <p className="eyebrow mb-1">{eyebrow}</p> : null}
        <h2 className="truncate text-[0.9375rem] font-semibold text-content">{title}</h2>
        {description ? (
          <p className="mt-0.5 text-xs text-content-muted">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function PanelBody({ children, className }: PanelProps) {
  return <div className={cn('p-4', className)}>{children}</div>;
}

export function PanelFooter({ children, className }: PanelProps) {
  return (
    <footer
      className={cn(
        'flex items-center justify-between gap-3 border-t border-hairline px-4 py-2.5 text-xs text-content-muted',
        className,
      )}
    >
      {children}
    </footer>
  );
}
