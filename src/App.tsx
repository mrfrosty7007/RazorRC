import { HashRouter, Route, Routes } from 'react-router-dom';
import { SessionProvider } from '@/app/SessionContext';
import { AppShell } from '@/components/layout';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { RecoveryQueuePage } from '@/features/queue/RecoveryQueuePage';
import { CopilotPage } from '@/features/copilot/CopilotPage';
import { AnalyticsPage } from '@/features/analytics/AnalyticsPage';
import { AuditTrailPage } from '@/features/audit/AuditTrailPage';
import { NotFoundPage } from '@/features/misc/NotFoundPage';

/**
 * `HashRouter`, deliberately.
 *
 * A packaged Tauri build serves the bundle from a custom protocol with no
 * server-side rewrite, so a browser-history route survives navigation but breaks
 * on reload or on a restored window. Hash routing keeps deep links such as
 * `#/queue?job=job_0042` working in development and in the shipped app alike.
 */
export function App() {
  return (
    <HashRouter>
      <SessionProvider>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<DashboardPage />} />
            <Route path="queue" element={<RecoveryQueuePage />} />
            <Route path="copilot" element={<CopilotPage />} />
            <Route path="analytics" element={<AnalyticsPage />} />
            <Route path="audit" element={<AuditTrailPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </SessionProvider>
    </HashRouter>
  );
}
