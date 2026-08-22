import { Bot, ChevronRight, ScrollText, User, Webhook, Wrench } from 'lucide-react';
import type { ActorType, AuditEvent } from '@/domain';
import { AUDIT_SEVERITIES, TONE_CLASSES } from '@/domain';
import { cn } from '@/lib/cn';
import { EmptyState, KeyValue, Skeleton, Tag } from '@/components/ui';
import { SeverityBadge } from '@/components/domain';
import { formatDayTime, formatRelative } from '@/lib/datetime';

const ACTOR_ICONS: Record<ActorType, typeof User> = {
  engine: Bot,
  user: User,
  webhook: Webhook,
  system: Wrench,
};

const ACTOR_LABELS: Record<ActorType, string> = {
  engine: 'Recovery engine',
  user: 'Person',
  webhook: 'Razorpay webhook',
  system: 'System',
};

interface AuditEventListProps {
  events: AuditEvent[];
  loading?: boolean;
  expandedId: string | null;
  onToggle: (eventId: string) => void;
  onOpenJob: (jobId: string) => void;
  /** Highlighted in summaries so a search term is visible in context. */
  highlight: string;
}

/**
 * The audit trail as an append-only ledger.
 *
 * Two things every row must answer without being opened: who did this, and did
 * it touch money. So the actor is an explicit icon and label rather than an
 * inferred style, and severity is a badge rather than a colour on the text.
 */
export function AuditEventList({
  events,
  loading = false,
  expandedId,
  onToggle,
  onOpenJob,
  highlight,
}: AuditEventListProps) {
  if (loading) {
    return (
      <div className="space-y-3 p-4">
        {Array.from({ length: 8 }, (_, index) => (
          <div key={index} className="flex items-center gap-3">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-3 flex-1" />
          </div>
        ))}
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <EmptyState
        icon={ScrollText}
        title="No events match this view"
        description="The trail records every engine decision, webhook and human override. Widen the filters to see more of it."
      />
    );
  }

  return (
    <ol className="divide-hairline-y">
      {events.map((event) => {
        const spec = AUDIT_SEVERITIES[event.severity];
        const expanded = expandedId === event.id;
        const ActorIcon = ACTOR_ICONS[event.actor.type];
        const metadata = Object.entries(event.metadata);
        const jobId = event.jobId;

        return (
          <li key={event.id}>
            <button
              type="button"
              onClick={() => onToggle(event.id)}
              aria-expanded={expanded}
              className="flex w-full items-start gap-3 px-4 py-2.5 text-left transition-colors hover:bg-raised"
            >
              <ChevronRight
                aria-hidden
                className={cn(
                  'mt-0.5 h-3.5 w-3.5 shrink-0 text-content-faint transition-transform',
                  expanded && 'rotate-90',
                )}
              />

              <span
                aria-hidden
                className={cn(
                  'mt-[0.4375rem] h-1.5 w-1.5 shrink-0 rounded-full',
                  TONE_CLASSES[spec.tone].dot,
                )}
              />

              <time
                dateTime={event.at}
                title={formatRelative(event.at)}
                className="w-[7.5rem] shrink-0 font-mono text-micro text-content-faint"
              >
                {formatDayTime(event.at)}
              </time>

              <span className="flex w-[8.5rem] shrink-0 items-center gap-1.5 text-micro text-content-muted">
                <ActorIcon aria-hidden className="h-3 w-3 shrink-0 text-content-faint" />
                <span className="truncate" title={ACTOR_LABELS[event.actor.type]}>
                  {event.actor.name}
                </span>
              </span>

              <span className="min-w-0 flex-1 text-[0.8125rem] leading-snug text-content">
                {highlightMatch(event.summary, highlight)}
              </span>

              <span className="hidden shrink-0 lg:block">
                <Tag>{event.action}</Tag>
              </span>
            </button>

            {expanded ? (
              <div className="animate-fade-rise border-t border-hairline bg-canvas/40 px-4 py-3.5 pl-[2.125rem]">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <SeverityBadge severity={event.severity} />
                  <Tag>{event.action}</Tag>
                  {jobId ? (
                    <button
                      type="button"
                      onClick={() => onOpenJob(jobId)}
                      className="text-micro font-medium text-azure-soft hover:text-azure"
                    >
                      Open recovery job →
                    </button>
                  ) : null}
                </div>

                <KeyValue
                  columns={2}
                  items={[
                    { label: 'Event id', value: <span className="font-mono">{event.id}</span> },
                    {
                      label: 'Recorded at',
                      value: <span className="font-mono">{formatDayTime(event.at)}</span>,
                    },
                    {
                      label: 'Actor',
                      value: `${event.actor.name} · ${ACTOR_LABELS[event.actor.type]}`,
                    },
                    {
                      label: 'Job',
                      value: <span className="font-mono">{jobId ?? 'not job-scoped'}</span>,
                    },
                  ]}
                />

                {metadata.length > 0 ? (
                  <div className="mt-3.5 rounded-panel border border-hairline bg-raised p-3">
                    <h4 className="eyebrow mb-2.5">Context</h4>
                    <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {metadata.map(([key, value]) => (
                        <div key={key} className="flex items-baseline justify-between gap-3">
                          <dt className="font-mono text-micro text-content-faint">{key}</dt>
                          <dd
                            className="truncate font-mono text-micro text-content"
                            data-selectable
                            title={value}
                          >
                            {value}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                ) : (
                  <p className="mt-3 text-micro text-content-faint">
                    No additional context was recorded for this event.
                  </p>
                )}
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/** Wraps search hits so a filtered trail shows why each row matched. */
function highlightMatch(text: string, needle: string) {
  const term = needle.trim();
  if (term.length < 2) return text;

  const index = text.toLowerCase().indexOf(term.toLowerCase());
  if (index === -1) return text;

  return (
    <>
      {text.slice(0, index)}
      <mark className="rounded-[2px] bg-azure/25 px-0.5 text-content">
        {text.slice(index, index + term.length)}
      </mark>
      {text.slice(index + term.length)}
    </>
  );
}
