import type { CustomerRef } from '@/domain';
import { cn } from '@/lib/cn';

interface CustomerCellProps {
  customer: CustomerRef;
  /** Secondary line: email by default, or a caller-supplied detail. */
  secondary?: string;
  className?: string;
}

export function CustomerCell({ customer, secondary, className }: CustomerCellProps) {
  return (
    <div className={cn('min-w-0', className)}>
      <p className="truncate font-medium text-content">{customer.name}</p>
      <p className="truncate font-mono text-micro text-content-faint" data-selectable>
        {secondary ?? customer.email}
      </p>
    </div>
  );
}
