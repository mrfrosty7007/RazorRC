import { NavLink } from 'react-router-dom';
import { cn } from '@/lib/cn';
import { NAV_GROUPS, NAV_ROUTES } from '@/app/routes';
import { useSession } from '@/app/SessionContext';
import { formatRelative } from '@/lib/datetime';

/**
 * Fixed navigation rail. Collapses to icons below `lg` with no state to
 * manage -- the window either has room for the labels or it does not.
 */
export function Sidebar() {
  return (
    <nav
      aria-label="Main"
      className="flex w-14 shrink-0 flex-col border-r border-hairline bg-surface lg:w-sidebar"
    >
      <Wordmark />

      <div className="flex-1 overflow-y-auto px-2 py-3">
        {NAV_GROUPS.map((group) => (
          <div key={group.id} className="mb-5 last:mb-0">
            <p className="eyebrow mb-1.5 hidden px-2 lg:block">{group.label}</p>
            <ul className="space-y-0.5">
              {NAV_ROUTES.filter((route) => route.group === group.id).map((route) => (
                <li key={route.path}>
                  <NavLink
                    to={route.path}
                    end={route.path === '/'}
                    title={route.label}
                    className={({ isActive }) =>
                      cn(
                        'flex items-center gap-2.5 rounded-control px-2 py-2 text-[0.8125rem] font-medium transition-colors duration-100',
                        'justify-center lg:justify-start',
                        isActive
                          ? 'bg-azure-dim text-content shadow-[inset_2px_0_0_0_#3D7DFF]'
                          : 'text-content-muted hover:bg-raised hover:text-content',
                      )
                    }
                  >
                    <route.icon aria-hidden className="h-4 w-4 shrink-0" strokeWidth={1.75} />
                    <span className="hidden truncate lg:block">{route.label}</span>
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <EngineStatusFooter />
    </nav>
  );
}

function Wordmark() {
  return (
    <div className="flex h-topbar shrink-0 items-center gap-2.5 border-b border-hairline px-3 lg:px-4">
      {/* Two arcs closing a loop: money leaving, money coming back. */}
      <svg
        aria-hidden
        viewBox="0 0 24 24"
        className="h-[1.375rem] w-[1.375rem] shrink-0"
        fill="none"
      >
        <path
          d="M12 3.5a8.5 8.5 0 1 1-8.02 5.66"
          stroke="#3D7DFF"
          strokeWidth="2.25"
          strokeLinecap="round"
        />
        <path d="M3.6 4.4v4.9h4.9" stroke="#17C79A" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="hidden lg:block">
        <span className="text-sm font-semibold tracking-tight text-content">Razor</span>
        <span className="text-sm font-semibold tracking-tight text-azure">RC</span>
      </span>
    </div>
  );
}

function EngineStatusFooter() {
  const { engine } = useSession();

  return (
    <div className="shrink-0 border-t border-hairline px-3 py-3 lg:px-4">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={cn(
            'h-1.5 w-1.5 shrink-0 rounded-full',
            engine?.running ? 'animate-live-pulse bg-mint' : 'bg-content-faint',
          )}
        />
        <p className="hidden truncate text-micro font-medium text-content-muted lg:block">
          {engine === null
            ? 'Checking engine…'
            : engine.running
              ? 'Recovery engine running'
              : 'Recovery engine stopped'}
        </p>
      </div>

      {engine ? (
        <dl className="mt-2 hidden space-y-1 lg:block">
          <div className="flex items-center justify-between gap-2">
            <dt className="text-micro text-content-faint">Queue depth</dt>
            <dd className="font-mono text-micro text-content-muted">{engine.queueDepth}</dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-micro text-content-faint">Last sweep</dt>
            <dd className="font-mono text-micro text-content-muted">
              {engine.lastSweepAt ? formatRelative(engine.lastSweepAt) : '—'}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-micro text-content-faint">Data source</dt>
            <dd
              className={cn(
                'font-mono text-micro',
                engine.source === 'rust-engine' ? 'text-mint' : 'text-amber',
              )}
            >
              {engine.source === 'rust-engine' ? 'Rust engine' : 'Dev seed'}
            </dd>
          </div>
        </dl>
      ) : null}
    </div>
  );
}
