import { RotateCcw } from 'lucide-react';
import type { FailureReason, PaymentMethod, QueueFilters, RecoveryStatus, RiskTier } from '@/domain';
import {
  FAILURE_REASONS,
  PAYMENT_METHODS,
  RECOVERY_STATUSES,
  RISK_TIERS,
} from '@/domain';
import { Button, FilterMenu, SearchInput, type FilterOption } from '@/components/ui';
import { formatCount } from '@/lib/format';

/**
 * Filter options are derived from the label maps, so a new failure reason in the
 * domain model appears in the filter without anyone remembering to add it here.
 */
function optionsFrom<T extends string>(
  spec: Record<T, { label: string }>,
  order: T[],
): FilterOption<T>[] {
  return order.map((value) => ({ value, label: spec[value].label }));
}

const STATUS_ORDER: RecoveryStatus[] = [
  'queued',
  'scheduled',
  'in_progress',
  'awaiting_customer',
  'recovered',
  'failed',
  'written_off',
  'suppressed',
];

const REASON_ORDER = Object.keys(FAILURE_REASONS) as FailureReason[];
const METHOD_ORDER = Object.keys(PAYMENT_METHODS) as PaymentMethod[];
const RISK_ORDER: RiskTier[] = ['critical', 'high', 'medium', 'low'];

interface QueueFilterBarProps {
  filters: QueueFilters;
  /** Raw text, kept separate from `filters.search` because that value is debounced. */
  searchDraft: string;
  onSearchDraftChange: (value: string) => void;
  onChange: (next: QueueFilters) => void;
  onReset: () => void;
  matchCount: number | null;
}

export function QueueFilterBar({
  filters,
  searchDraft,
  onSearchDraftChange,
  onChange,
  onReset,
  matchCount,
}: QueueFilterBarProps) {
  const activeCount =
    filters.statuses.length +
    filters.reasons.length +
    filters.methods.length +
    filters.riskTiers.length +
    (filters.search ? 1 : 0);

  return (
    <div className="space-y-2.5 border-b border-hairline p-4">
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-5">
        <SearchInput
          value={searchDraft}
          onChange={onSearchDraftChange}
          placeholder="Search customer, email or payment id"
          className="xl:col-span-1"
        />
        <FilterMenu
          label="Status"
          options={optionsFrom(RECOVERY_STATUSES, STATUS_ORDER)}
          selected={filters.statuses}
          onChange={(statuses) => onChange({ ...filters, statuses })}
        />
        <FilterMenu
          label="Reason"
          options={optionsFrom(FAILURE_REASONS, REASON_ORDER)}
          selected={filters.reasons}
          onChange={(reasons) => onChange({ ...filters, reasons })}
        />
        <FilterMenu
          label="Method"
          options={optionsFrom(PAYMENT_METHODS, METHOD_ORDER)}
          selected={filters.methods}
          onChange={(methods) => onChange({ ...filters, methods })}
        />
        <FilterMenu
          label="Risk"
          options={optionsFrom(RISK_TIERS, RISK_ORDER)}
          selected={filters.riskTiers}
          onChange={(riskTiers) => onChange({ ...filters, riskTiers })}
        />
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className="font-mono text-micro text-content-faint">
          {matchCount === null
            ? 'Counting matches…'
            : `${formatCount(matchCount)} ${matchCount === 1 ? 'job' : 'jobs'} match${
                activeCount === 0 ? '' : ` ${activeCount} ${activeCount === 1 ? 'filter' : 'filters'}`
              }`}
        </p>
        {activeCount > 0 ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={onReset}
            icon={<RotateCcw className="h-3.5 w-3.5" />}
          >
            Reset filters
          </Button>
        ) : null}
      </div>
    </div>
  );
}
