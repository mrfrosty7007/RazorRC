import { KeyRound, Send, WifiOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getCopilotStatus, streamCopilotAnswer, type CopilotStatus } from '@/data/copilot';
import { cn } from '@/lib/cn';
import { Badge, Button, Callout, Panel, PanelBody, PanelHeader } from '@/components/ui';

interface CopilotComposerProps { scopedJobIds: string[]; className?: string; }
interface Answer { text: string; streaming: boolean; }
const INITIAL_STATUS: CopilotStatus = { configured: false, model: 'Gemini 2.5 Flash' };

/** Session-only, streamed, advisory conversation. No answer is persisted. */
export function CopilotComposer({ scopedJobIds, className }: CopilotComposerProps) {
  const [status, setStatus] = useState<CopilotStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getCopilotStatus().then((next) => active && setStatus(next)).catch(() => {
      if (active) { setStatus(INITIAL_STATUS); setStatusError('Could not check the Gemini configuration. Restart ReviveAI and try again.'); }
    });
    return () => { active = false; };
  }, []);

  const ready = status?.configured === true;
  async function submit() {
    const question = prompt.trim();
    if (!question || !ready || asking) return;
    setAsking(true); setError(null); setPrompt('');
    const answerIndex = answers.length;
    setAnswers((current) => [...current, { text: '', streaming: true }]);
    try {
      await streamCopilotAnswer({ prompt: question, jobIds: scopedJobIds }, (event) => {
        if (event.kind !== 'delta' || !event.text) return;
        setAnswers((current) => current.map((answer, index) => index === answerIndex ? { ...answer, text: answer.text + event.text } : answer));
      });
      setAnswers((current) => current.map((answer, index) => index === answerIndex ? { text: answer.text || 'Gemini returned no text. Please try again.', streaming: false } : answer));
    } catch (cause: unknown) {
      setAnswers((current) => current.filter((_, index) => index !== answerIndex));
      setError(cause instanceof Error ? cause.message : 'The copilot could not answer that question.');
    } finally { setAsking(false); }
  }

  return <Panel className={cn('flex flex-col', className)}>
    <PanelHeader eyebrow="Gemini · advisory only" title="Ask about your recovery data" description="PII-redacted job summaries are analysed; recommendations always need your approval" actions={ready ? <Badge tone="mint" dot>{status?.model}</Badge> : <Badge tone="amber" dot>Not connected</Badge>} />
    <PanelBody className="flex flex-1 flex-col gap-3">
      {status === null ? <p className="font-mono text-micro text-content-faint">Checking Gemini connection…</p> : null}
      {!ready && status !== null ? <Callout tone="amber" title="Gemini is not configured">Add <code className="font-mono text-micro text-content">COPILOT_API_KEY</code> to the local <code className="font-mono text-micro text-content">.env</code> file, then restart ReviveAI. The rules-based recommendations and playbooks remain available without it.</Callout> : null}
      {statusError ? <Callout tone="coral" title="Connection check failed">{statusError}</Callout> : null}
      {answers.length > 0 ? <ol className="space-y-3" aria-live="polite">{answers.map((answer, index) => <li key={index} className="rounded-panel border border-hairline bg-raised p-3 text-xs leading-relaxed text-content-muted"><p className="whitespace-pre-wrap">{answer.text || 'Thinking…'}</p><p className="mt-2 font-mono text-micro text-content-faint">{answer.streaming ? 'streaming…' : 'Advisory only — no action was taken'}</p></li>)}</ol> : null}
      {error ? <Callout tone="coral" title="The question could not be answered">{error}</Callout> : null}
      <div className="mt-auto">
        <label htmlFor="copilot-prompt" className="eyebrow mb-1.5 block">Your question</label>
        <textarea id="copilot-prompt" rows={3} value={prompt} disabled={!ready || asking} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void submit(); }} placeholder={ready ? 'Which failure reason lost us the most money this week?' : 'Available once Gemini is configured'} data-selectable className={cn('w-full resize-none rounded-panel border border-hairline bg-surface p-3', 'text-[0.8125rem] leading-relaxed text-content placeholder:text-content-faint', 'transition-colors duration-150 focus:border-azure/60', 'disabled:cursor-not-allowed disabled:bg-canvas disabled:text-content-faint')} />
        <div className="mt-2 flex items-center justify-between gap-3"><p className="flex items-center gap-1.5 font-mono text-micro text-content-faint">{ready ? <>PII redacted · scoped to {scopedJobIds.length} open jobs · ⌘↵ to send</> : <><KeyRound aria-hidden className="h-3 w-3" /> credentials required</>}</p><Button size="sm" variant="primary" disabled={!ready || prompt.trim().length === 0} busy={asking} onClick={() => void submit()} icon={ready ? <Send className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}>Ask</Button></div>
      </div>
    </PanelBody>
  </Panel>;
}
