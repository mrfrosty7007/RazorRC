import { Component, type ErrorInfo, type ReactNode } from 'react';
import { RotateCcw, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Last line of defence around a page.
 *
 * A throw during render unmounts the whole React tree, and in a desktop window
 * that means a blank frame the operator can only escape by relaunching the app.
 * This keeps the sidebar and topbar alive, names the failure, and offers a way
 * back — the recovery queue is an operations console, so losing the chrome
 * mid-shift is worse than losing one panel.
 *
 * Mount it with `key={pathname}` so navigating away clears the error instead of
 * leaving the operator stuck on the failed page.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Console is the only sink available offline; the audit trail is for
    // merchant actions, not for our own crashes.
    console.error('[ReviveAI] page crashed', error, info.componentStack);
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <section
        role="alert"
        className="mx-auto flex max-w-lg flex-col items-center px-6 py-16 text-center"
      >
        <div className="mb-3.5 flex h-10 w-10 items-center justify-center rounded-panel border border-hairline bg-raised">
          <TriangleAlert aria-hidden className="h-4 w-4 text-amber" strokeWidth={1.75} />
        </div>
        <p className="text-[0.9375rem] font-semibold text-content">This page stopped responding</p>
        <p className="mt-1 text-xs leading-relaxed text-content-muted">
          Your recovery data is untouched — nothing was lost. Try again, and if it keeps happening
          the message below is what to report.
        </p>
        <p className="mt-4 w-full break-words rounded-control border border-hairline bg-raised px-3 py-2 text-left font-mono text-micro text-content-faint">
          {error.message || String(error)}
        </p>
        <Button
          className="mt-4"
          size="sm"
          variant="secondary"
          onClick={this.reset}
          icon={<RotateCcw className="h-3.5 w-3.5" />}
        >
          Try again
        </Button>
      </section>
    );
  }
}
