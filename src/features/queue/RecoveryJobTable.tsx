import { Inbox } from 'lucide-react';
import type { ReactNode } from 'react';
import type { RecoveryJob } from '@/domain';
import { DataTable, EmptyState, ScoreTicks, type Column } from '@/components/ui';
import {
  ActionBadge,
  CustomerCell,
  MethodTag,
  Money,
  PaymentRef,
  ReasonBadge,
  RiskBadge,
  StatusBadge,
} from '@/components/domain';
import { formatRelative } from '@/lib/datetime';

type ColumnId =
  | 'customer'
  | 'amount'
  | 'reason'
  | 'method'
  | 'score'
  | 'status'
  | 'nextAction'
  | 'risk';

const FULL: ColumnId[] = [
  'customer',
  'amount',
  'reason',
  'method',
  'score',
  'status',
  'nextAction',
  'risk',
];

/** The dashboard preview drops the columns a merchant can get from the queue. */
const COMPACT: ColumnId[] = ['customer', 'amount', 'reason', 'score', 'status', 'nextAction'];

interface RecoveryJobTableProps {
  jobs: RecoveryJob[];
  loading?: boolean;
  variant?: 'full' | 'compact';
  onSelect?: (job: RecoveryJob) => void;
  activeJobId?: string | null;
  /** Replaces the default empty state, e.g. when filters are active. */
  empty?: ReactNode;
}

/**
 * The single recovery-job table. The queue page and the dashboard render the
 * same component with different column sets, so a status pill never means one
 * thing on one screen and something else on another.
 */
export function RecoveryJobTable({
  jobs,
  loading = false,
  variant = 'full',
  onSelect,
  activeJobId,
  empty,
}: RecoveryJobTableProps) {
  const wanted = variant === 'full' ? FULL : COMPACT;
  const columns = ALL_COLUMNS.filter((column) => wanted.includes(column.id as ColumnId));

  return (
    <DataTable
      columns={columns}
      rows={jobs}
      getRowId={(job) => job.id}
      loading={loading}
      onRowClick={onSelect}
      activeRowId={activeJobId}
      density={variant === 'compact' ? 'compact' : 'regular'}
      empty={
        empty ?? (
          <EmptyState
            icon={Inbox}
            title="No failed payments in this window"
            description="When a payment fails, Razorpay sends a webhook and the job appears here within seconds."
          />
        )
      }
    />
  );
}

const ALL_COLUMNS: Column<RecoveryJob>[] = [
  {
    id: 'customer',
    header: 'Customer',
    width: 'w-[24%]',
    cell: (job) => (
      <div className="min-w-0">
        <CustomerCell customer={job.payment.customer} />
        <div className="mt-0.5">
          <PaymentRef value={job.payment.razorpayPaymentId} />
        </div>
      </div>
    ),
  },
  {
    id: 'amount',
    header: 'Amount',
    align: 'right',
    cell: (job) => (
      <div>
        <Money paise={job.payment.amountPaise} variant="exact" className="text-content" />
        {job.payment.isSubscription ? (
          <p className="mt-0.5 text-micro text-content-faint">Subscription</p>
        ) : null}
      </div>
    ),
  },
  {
    id: 'reason',
    header: 'Failure reason',
    cell: (job) => <ReasonBadge reason={job.payment.failureReason} />,
  },
  {
    id: 'method',
    header: 'Method',
    hideBelow: 'lg',
    cell: (job) => <MethodTag method={job.payment.method} network={job.payment.cardNetwork} />,
  },
  {
    id: 'score',
    header: 'Recovery score',
    hideBelow: 'md',
    cell: (job) => <ScoreTicks value={job.recoveryScore} />,
  },
  {
    id: 'status',
    header: 'Status',
    cell: (job) => <StatusBadge status={job.status} />,
  },
  {
    id: 'nextAction',
    header: 'Next action',
    hideBelow: 'xl',
    cell: (job) => (
      <div className="min-w-0">
        <ActionBadge kind={job.recommendedAction.kind} />
        <p className="mt-0.5 font-mono text-micro text-content-faint">
          {job.nextActionAt ? formatRelative(job.nextActionAt) : 'Nothing scheduled'}
        </p>
      </div>
    ),
  },
  {
    id: 'risk',
    header: 'Risk',
    hideBelow: 'xl',
    cell: (job) => <RiskBadge tier={job.riskTier} />,
  },
];
