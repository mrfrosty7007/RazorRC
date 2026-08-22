import { KeyRound, Send } from 'lucide-react';
import { useState } from 'react';
import { copilot, type CopilotAnswer } from '@/data/copilot';
import { cn } from '@/lib/cn';
import { Badge, Button, Callout, Panel, PanelBody, PanelHeader } from '@/components/ui';

interface CopilotComposerProps {
  /** Jobs the question is scoped to, so an answer can cite them. */
  scopedJobIds: string[];
  className?: string;
}

/**
 * The conversational surface -- wired to the real Copilot port, and nothing else.
 *
 * Phase 1 has no model provider, so this renders as disabled and names the exact
 * credentials that are missing. There is no scripted transcript and no canned
 * reply: a simulated assistant would teach a merchant to trust output that no
 * system actually produced, which is the opposite of what the rest of this app
 * is built to do. When a provider is registered, `availability()` flips to
 * `ready` and this component starts working unchanged.
 */
export function CopilotComposer({ scopedJobIds, className }: CopilotComposerProps) {
  const availability = copilot.availability();
  const ready = availability.status === 'ready';

  const [prompt, setPrompt] = useState('');
  const [answers, setAnswers] = useState<CopilotAnswer[]>([]);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const question = prompt.trim();
    if (!question || !ready) return;

    setAsking(true);
    setError(null);
    try {
      const answer = await copilot.ask({ prompt: question, jobIds: scopedJobIds });
      setAnswers((current) => [...current, answer]);
      setPrompt('');
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAsking(false);
    }
  }

  return (
    <Panel className={cn('flex flex-col', className)}>
      <PanelHeader
        eyebrow="Natural language"
        title="Ask about your recovery data"
        description="Questions are answered from your own jobs, with the rows cited"
        actions={
          ready ? (
            <Badge tone="mint" dot>
              {availability.status === 'ready' ? availability.model : 'Connected'}
            </Badge>
          ) : (
            <Badge tone="amber" dot>
              Not connected
            </Badge>
          )
        }
      />

      <PanelBody className="flex flex-1 flex-col gap-3">
        {availability.status === 'not_configured' ? (
          <Callout tone="amber" title="No language model is configured">
            <p>
              Set{' '}
              {availability.missing.map((key, index) => (
                <span key={key}>
                  {index > 0 ? ' and ' : ''}
                  <code className="rounded bg-overlay px-1 py-0.5 font-mono text-micro text-content">
                    {key}
                  </code>
                </span>
              ))}{' '}
              in <code className="font-mono text-micro text-content">.env</code> to enable this
              panel. Until then ReviveAI shows only what the recovery engine actually computed —
              the recommendations and evidence on this page are produced by deterministic rules, not
              by a model, and they work with no credentials at all.
            </p>
          </Callout>
        ) : null}

        {availability.status === 'error' ? (
          <Callout tone="coral" title="The copilot provider rejected the connection">
            {availability.message}
          </Callout>
        ) : null}

        {answers.length > 0 ? (
          <ol className="space-y-3">
            {answers.map((answer, index) => (
              <li
                key={index}
                className="rounded-panel border border-hairline bg-raised p-3 text-xs leading-relaxed text-content-muted"
              >
                <p>{answer.text}</p>
                {answer.citedJobIds.length > 0 ? (
                  <p className="mt-2 font-mono text-micro text-content-faint">
                    cites {answer.citedJobIds.length} jobs
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        ) : null}

        {error ? (
          <Callout tone="coral" title="The question could not be answered">
            {error}
          </Callout>
        ) : null}

        <div className="mt-auto">
          <label htmlFor="copilot-prompt" className="eyebrow mb-1.5 block">
            Your question
          </label>
          <textarea
            id="copilot-prompt"
            rows={3}
            value={prompt}
            disabled={!ready}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void submit();
            }}
            placeholder={
              ready
                ? 'Which failure reason lost us the most money this week?'
                : 'Available once a language model is configured'
            }
            data-selectable
            className={cn(
              'w-full resize-none rounded-panel border border-hairline bg-surface p-3',
              'text-[0.8125rem] leading-relaxed text-content placeholder:text-content-faint',
              'transition-colors duration-150 focus:border-azure/60',
              'disabled:cursor-not-allowed disabled:bg-canvas disabled:text-content-faint',
            )}
          />

          <div className="mt-2 flex items-center justify-between gap-3">
            <p className="flex items-center gap-1.5 font-mono text-micro text-content-faint">
              {ready ? (
                <>scoped to {scopedJobIds.length} open jobs · ⌘↵ to send</>
              ) : (
                <>
                  <KeyRound aria-hidden className="h-3 w-3" />
                  credentials required
                </>
              )}
            </p>
            <Button
              size="sm"
              variant="primary"
              disabled={!ready || prompt.trim().length === 0}
              busy={asking}
              onClick={() => void submit()}
              icon={<Send className="h-3.5 w-3.5" />}
            >
              Ask
            </Button>
          </div>
        </div>
      </PanelBody>
    </Panel>
  );
}
