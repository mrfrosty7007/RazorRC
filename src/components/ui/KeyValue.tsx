import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

interface KeyValueProps {
  items: { label: string; value: ReactNode }[];
  /** Two columns for detail panels, one for narrow rails. */
  columns?: 1 | 2;
  className?: string;
}

/** Definition list for record details and audit metadata. */
export function KeyValue({ items, columns = 2, className }: KeyValueProps) {
  return (
    <dl
      className={cn(
        'grid gap-x-6 gap-y-3',
        columns === 2 ? 'grid-cols-2' : 'grid-cols-1',
        className,
      )}
    >
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="eyebrow">{item.label}</dt>
          <dd className="mt-1 truncate text-[0.8125rem] text-content" data-selectable>
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
