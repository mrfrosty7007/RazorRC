import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';

/** Sidebar plus topbar chrome. The page scrolls, the chrome does not. */
export function AppShell() {
  return (
    <div className="flex h-full overflow-hidden bg-canvas">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main className="flex-1 overflow-y-auto px-5 py-5">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
