import { ArrowRight, Sparkles } from 'lucide-react';
import { useState } from 'react';
import type { Insight } from '@/domain';
import { INSIGHT_KINDS, TONE_CLASSES } from '@/domain';
import { cn } from '@/lib/cn';
import { Badge, Button, EmptyState, Panel, PanelHeader, Skeleton } from '@/components/ui';
import { Money, SignalList } from '@/components/domain';
import { formatPercent } from '@/lib/format';
import { formatRelative } from '@/lib/datetime';

interface AiInsightPanelProps {
  insights: Insight[];
  loading?: boolean;
  onOpenCopilot: () => void;
  className?: string;
}

/**
 * Findings from the recovery engine, ranked by the money they move.
 *
 * Attribution is explicit and evidence is always one click away: a claim about
 * a merchant's revenue that cannot be checked is worse than no claim at all.
 * Nothing here is model-generated prose -- each finding is a rule firing on the
 * merchant's own job data, and the signals show which inputs fired it.
 */
export function AiInsightPanel({
  insights,
  loading = false,
  onOpenCopilot,
  className,
}: AiInsightPanelProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const ranked = [...insights].sort((a, b) => b.impactPaise - a.impactPaise);
  const lead = ranked[0];
  // The highest-impact finding is open by default; '' means the user closed it.
  const expandedId = openId ?? lead?.id ?? null;

  return (
    <Panel className={cn('flex flex-col', className)}>
      <PanelHeader
        eyebrow="Recovery engine"
        title="AI insight"
        description="Rules firing on your own data, ranked by rupees at stake"
        actions={
          <Badge tone="violet" dot live>
            Live
          </Badge>
        }
      />

      {loading ? (
        <div className="space-y-3 p-4">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : ranked.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          title="Nothing needs your attention"
          description="The engine raises a finding when a failure pattern breaks from its baseline or a recoverable batch builds up."
        />
      ) : (
        <>
          <ul className="divide-hairline-y flex-1">
            {ranked.map((insight) => {
              const spec = INSIGHT_KINDS[insight.kind];
              const expanded = insight.id === expandedId;

              return (
                <li key={insight.id}>
                  <button
                    type="button"
                    onClick={() => setOpenId(expanded ? '' : insight.id)}
                    aria-expanded={expanded}
                    className="w-full px-4 py-3 text-left transition-colors hover:bg-raised"
                  >
                    <div className="flex items-start gap-2.5">
                      <span
                        aria-hidden
                        className={cn(
                          'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
                          TONE_CLASSES[spec.tone].dot,
                        )}
                      />
                      <div className="min-w-0 flex-1">
                        <p
                          className={cn(
                            'text-[0.8125rem] font-semibold leading-snug',
                            expanded ? 'text-content' : 'text-content-muted',
                          )}
                        >
                          {insight.headline}
                        </p>
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                          <span className={cn('text-micro font-medium', TONE_CLASSES[spec.tone].text)}>
                            {spec.label}
                          </span>
                          <Money
                            paise={insight.impactPaise}
                            variant="compact"
                            className="text-micro text-content"
                          />
                          <span className="font-mono text-micro text-content-faint">
                            {formatPercent(insight.confidence, 0)} confidence
                          </span>
                          <span className="font-mono text-micro text-content-faint">
                            {formatRelative(insight.detectedAt)}
                          </span>
                        </div>
                      </div>
                    </div>
                  </button>

                  {expanded ? (
                    <div className="animate-fade-rise px-4 pb-4 pl-[2.125rem]">
                      <p className="text-xs leading-relaxed text-content-muted">{insight.body}</p>

                      <div className="mt-3.5 rounded-panel border border-hairline bg-raised p-3">
                        <h4 className="eyebrow mb-2.5">Evidence</h4>
                        <SignalList signals={insight.evidence} />
                      </div>

                      {insight.suggestedAction ? (
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <Button size="sm" variant="primary" onClick={onOpenCopilot}>
                            {insight.suggestedAction.label}
                          </Button>
                          <span className="font-mono text-micro text-content-faint">
                            applies to {insight.suggestedAction.jobIds.length} jobs
                          </span>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>

          <div className="border-t border-hairline px-4 py-2.5">
            <Button size="sm" variant="ghost" onClick={onOpenCopilot} className="w-full justify-between">
              Review playbooks in Copilot
              <ArrowRight aria-hidden className="h-3.5 w-3.5" />
            </Button>
          </div>
        </>
      )}
    </Panel>
  );
}
