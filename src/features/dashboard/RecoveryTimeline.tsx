import { History } from 'lucide-react';
import type { AuditEvent } from '@/domain';
import { AUDIT_SEVERITIES, TONE_CLASSES } from '@/domain';
import { cn } from '@/lib/cn';
import { EmptyState, Panel, PanelHeader, Skeleton } from '@/components/ui';
import { formatRelative, formatTime } from '@/lib/datetime';

interface RecoveryTimelineProps {
  events: AuditEvent[];
  loading?: boolean;
  onOpenAudit: () => void;
  className?: string;
}

/**
 * Recent recovery activity as a single vertical tape.
 *
 * Deliberately reads like a ledger roll rather than a feed of cards: the eye
 * runs down one rule, timestamps stay in a fixed monospaced column, and the
 * actor is always stated so engine actions are never mistaken for human ones.
 */
export function RecoveryTimeline({
  events,
  loading = false,
  onOpenAudit,
  className,
}: RecoveryTimelineProps) {
  return (
    <Panel className={cn('flex flex-col', className)}>
      <PanelHeader
        eyebrow="Last 24 hours"
        title="Recovery timeline"
        description="What the engine and your team did, most recent first"
        actions={
          <button
            type="button"
            onClick={onOpenAudit}
            className="text-micro font-medium text-azure-soft hover:text-azure"
          >
            Full audit trail
          </button>
        }
      />

      {loading ? (
        <div className="space-y-3 p-4">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="flex gap-3">
              <Skeleton className="h-3 w-10" />
              <Skeleton className="h-3 flex-1" />
            </div>
          ))}
        </div>
      ) : events.length === 0 ? (
        <EmptyState
          icon={History}
          title="Nothing has happened yet"
          description="Approve a recommendation or wait for the next queue sweep, and the activity will show up here."
        />
      ) : (
        <ol className="flex-1 overflow-y-auto px-4 py-3">
          {events.map((event, index) => {
            const spec = AUDIT_SEVERITIES[event.severity];
            const last = index === events.length - 1;

            return (
              <li key={event.id} className="flex gap-3">
                <time
                  dateTime={event.at}
                  title={formatRelative(event.at)}
                  className="w-10 shrink-0 pt-[0.1875rem] text-right font-mono text-micro text-content-faint"
                >
                  {formatTime(event.at)}
                </time>

                {/* Continuous rule with a node per event. */}
                <div className="relative flex w-3 shrink-0 justify-center">
                  <span
                    aria-hidden
                    className={cn('absolute top-0 w-px bg-hairline', last ? 'h-2' : 'h-full')}
                  />
                  <span
                    aria-hidden
                    className={cn(
                      'relative mt-1 h-1.5 w-1.5 shrink-0 rounded-full ring-2 ring-surface',
                      TONE_CLASSES[spec.tone].dot,
                    )}
                  />
                </div>

                <div className={cn('min-w-0 flex-1', last ? 'pb-0' : 'pb-3.5')}>
                  <p className="text-xs leading-snug text-content">{event.summary}</p>
                  <p className="mt-0.5 font-mono text-micro text-content-faint">
                    {event.actor.type === 'engine'
                      ? 'recovery engine'
                      : event.actor.type === 'webhook'
                        ? event.actor.name
                        : event.actor.name.toLowerCase()}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}
