import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { SkeletonRows } from './Skeleton';

export interface Column<T> {
  id: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** Numerals are right-aligned so digits line up down the column. */
  align?: 'left' | 'right';
  /** Width utility, e.g. `w-[22%]`. Omit to size from content. */
  width?: string;
  /** Drops the column on narrower windows instead of letting rows wrap. */
  hideBelow?: 'md' | 'lg' | 'xl';
}

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  getRowId: (row: T) => string;
  loading?: boolean;
  /** Rendered in place of the tbody when there are no rows. */
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
  activeRowId?: string | null;
  /** Row height. `compact` is for long scanning lists. */
  density?: 'compact' | 'regular';
  className?: string;
}

const HIDE_CLASSES = {
  md: 'hidden md:table-cell',
  lg: 'hidden lg:table-cell',
  xl: 'hidden xl:table-cell',
} as const;

/**
 * Dense enterprise table. Hairline rows, sticky header, one accent rule on the
 * hovered or selected row. Sorting and pagination live with the caller, which
 * owns the query.
 */
export function DataTable<T>({
  columns,
  rows,
  getRowId,
  loading = false,
  empty,
  onRowClick,
  activeRowId,
  density = 'regular',
  className,
}: DataTableProps<T>) {
  if (loading) {
    return <SkeletonRows rows={7} columns={Math.min(columns.length, 6)} />;
  }

  if (rows.length === 0) {
    return <>{empty}</>;
  }

  const cellPadding = density === 'compact' ? 'px-4 py-2' : 'px-4 py-2.5';
  const interactive = Boolean(onRowClick);

  return (
    <div className={cn('overflow-x-auto', className)}>
      <table className="w-full border-collapse text-left">
        <thead className="sticky top-0 z-10 bg-surface">
          <tr className="border-b border-hairline">
            {columns.map((column) => (
              <th
                key={column.id}
                scope="col"
                className={cn(
                  'eyebrow whitespace-nowrap bg-surface px-4 py-2.5 font-mono',
                  column.align === 'right' && 'text-right',
                  column.width,
                  column.hideBelow && HIDE_CLASSES[column.hideBelow],
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const rowId = getRowId(row);
            const isActive = activeRowId === rowId;

            return (
              <tr
                key={rowId}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onKeyDown={
                  onRowClick
                    ? (event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          onRowClick(row);
                        }
                      }
                    : undefined
                }
                tabIndex={interactive ? 0 : undefined}
                role={interactive ? 'button' : undefined}
                aria-current={isActive || undefined}
                className={cn(
                  'border-b border-hairline transition-colors duration-100',
                  interactive && 'cursor-pointer',
                  isActive
                    ? 'bg-raised shadow-[inset_2px_0_0_0_#3D7DFF]'
                    : interactive && 'hover:bg-raised hover:shadow-[inset_2px_0_0_0_#2A3950]',
                )}
              >
                {columns.map((column) => (
                  <td
                    key={column.id}
                    className={cn(
                      cellPadding,
                      'align-middle text-[0.8125rem] text-content',
                      column.align === 'right' && 'text-right',
                      column.hideBelow && HIDE_CLASSES[column.hideBelow],
                    )}
                  >
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
