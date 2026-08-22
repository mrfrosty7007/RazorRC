import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  /** What to do next. An empty screen is an invitation to act. */
  description: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center px-6 py-14 text-center', className)}>
      <div className="mb-3.5 flex h-10 w-10 items-center justify-center rounded-panel border border-hairline bg-raised">
        <Icon aria-hidden className="h-4 w-4 text-content-faint" strokeWidth={1.75} />
      </div>
      <p className="text-[0.9375rem] font-semibold text-content">{title}</p>
      <p className="mt-1 max-w-sm text-xs leading-relaxed text-content-muted">{description}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
