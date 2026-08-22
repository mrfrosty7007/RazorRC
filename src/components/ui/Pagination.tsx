import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from './Button';
import { formatCount } from '@/lib/format';

interface PaginationProps {
  offset: number;
  limit: number;
  total: number;
  onOffsetChange: (offset: number) => void;
  /** Plural noun for the row type, e.g. "jobs". */
  noun: string;
}

export function Pagination({ offset, limit, total, onOffsetChange, noun }: PaginationProps) {
  const first = total === 0 ? 0 : offset + 1;
  const last = Math.min(offset + limit, total);

  return (
    <>
      <p className="font-mono text-micro text-content-faint">
        {formatCount(first)}–{formatCount(last)} of {formatCount(total)} {noun}
      </p>
      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          variant="ghost"
          icon={<ChevronLeft className="h-3.5 w-3.5" />}
          disabled={offset === 0}
          onClick={() => onOffsetChange(Math.max(0, offset - limit))}
        >
          Previous
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={last >= total}
          onClick={() => onOffsetChange(offset + limit)}
        >
          Next
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </>
  );
}
