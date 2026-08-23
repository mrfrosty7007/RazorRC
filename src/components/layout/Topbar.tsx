import { RefreshCw } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { Badge, Button } from '@/components/ui';
import { useSession } from '@/app/SessionContext';
import { routeFor } from '@/app/routes';
import { formatTime } from '@/lib/datetime';

/**
 * Thin application bar. Holds the things that are true of the whole app --
 * which merchant, which Razorpay mode, when the data last moved -- and nothing
 * that belongs to a single page.
 */
export function Topbar() {
  const { merchant, engine, refresh, loading } = useSession();
  const { pathname } = useLocation();
  const route = routeFor(pathname);

  return (
    <header className="flex h-topbar shrink-0 items-center justify-between gap-4 border-b border-hairline bg-surface px-4">
      <div className="flex min-w-0 items-center gap-3">
        {/*
          Identity, not a switcher. The console is scoped to the Razorpay account
          whose keys are in the local config, so there is nothing to switch to —
          and a button that announces itself to a screen reader and then does
          nothing is worse than a label.
        */}
        <div
          className="flex min-w-0 items-center gap-2 rounded-control px-2 py-1"
          title="The Razorpay account these keys belong to"
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[0.25rem] border border-hairline-strong bg-raised font-mono text-micro font-semibold text-content-muted">
            {merchant ? initials(merchant.name) : '··'}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[0.8125rem] font-medium text-content">
              {merchant?.name ?? 'Loading account…'}
            </span>
            <span className="block truncate font-mono text-micro text-content-faint">
              {merchant?.id ?? '—'}
            </span>
          </span>
        </div>

        {merchant ? (
          <Badge tone={merchant.mode === 'test' ? 'amber' : 'mint'} className="hidden sm:inline-flex">
            {merchant.mode === 'test' ? 'Test mode' : 'Live mode'}
          </Badge>
        ) : null}

        {engine && !engine.razorpayConnected ? (
          <Badge
            tone="neutral"
            className="hidden lg:inline-flex"
            title="Add Razorpay Test Mode keys to start ingesting real failed payments"
          >
            Razorpay not connected
          </Badge>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-3">
        {route ? (
          <p className="hidden max-w-xs truncate text-micro text-content-faint xl:block">
            {route.description}
          </p>
        ) : null}
        <span className="hidden font-mono text-micro text-content-faint md:block">
          Synced {engine?.lastSweepAt ? formatTime(engine.lastSweepAt) : '—'}
        </span>
        <Button
          size="sm"
          variant="ghost"
          busy={loading}
          onClick={refresh}
          icon={<RefreshCw className="h-3.5 w-3.5" />}
          aria-label="Refresh"
        >
          Refresh
        </Button>
      </div>
    </header>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
}
