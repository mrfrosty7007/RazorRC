import { invoke } from '@tauri-apps/api/core';
import type {
  AttemptEffectiveness,
  AuditEvent,
  DashboardMetrics,
  EngineStatus,
  FailureBreakdown,
  Insight,
  Merchant,
  MethodBreakdown,
  Paged,
  Playbook,
  RecoveryJob,
  TrendPoint,
} from '@/domain';
import type { DataSource } from '../repositories';

/**
 * Tauri adapter. Every method maps 1:1 onto a `#[tauri::command]` in
 * `src-tauri/src/commands.rs`; the command names below are the contract.
 *
 * Rust returns `Result<T, String>`, so a rejected promise carries the engine's
 * error message and the calling screen renders it verbatim.
 */

const COMMANDS = {
  dashboardMetrics: 'get_dashboard_metrics',
  trend: 'get_trend',
  failureBreakdown: 'get_failure_breakdown',
  methodBreakdown: 'get_method_breakdown',
  attemptEffectiveness: 'get_attempt_effectiveness',
  listJobs: 'list_recovery_jobs',
  getJob: 'get_recovery_job',
  approveAction: 'approve_recommended_action',
  suppressJob: 'suppress_recovery_job',
  retryNow: 'retry_recovery_job_now',
  listInsights: 'list_insights',
  listPlaybooks: 'list_playbooks',
  setPlaybookEnabled: 'set_playbook_enabled',
  listAuditEvents: 'list_audit_events',
  engineStatus: 'get_engine_status',
  merchant: 'get_merchant',
} as const;

export const tauriAdapter: DataSource = {
  metrics: {
    getDashboardMetrics: (windowDays) =>
      invoke<DashboardMetrics>(COMMANDS.dashboardMetrics, { windowDays }),
    getTrend: (windowDays) => invoke<TrendPoint[]>(COMMANDS.trend, { windowDays }),
    getFailureBreakdown: (windowDays) =>
      invoke<FailureBreakdown[]>(COMMANDS.failureBreakdown, { windowDays }),
    getMethodBreakdown: (windowDays) =>
      invoke<MethodBreakdown[]>(COMMANDS.methodBreakdown, { windowDays }),
    getAttemptEffectiveness: (windowDays) =>
      invoke<AttemptEffectiveness[]>(COMMANDS.attemptEffectiveness, { windowDays }),
  },

  recovery: {
    listJobs: (filters, page) => invoke<Paged<RecoveryJob>>(COMMANDS.listJobs, { filters, page }),
    getJob: (jobId) => invoke<RecoveryJob | null>(COMMANDS.getJob, { jobId }),
    approveRecommendedAction: (jobId) => invoke<RecoveryJob>(COMMANDS.approveAction, { jobId }),
    suppressJob: (jobId, reason) => invoke<RecoveryJob>(COMMANDS.suppressJob, { jobId, reason }),
    retryNow: (jobId) => invoke<RecoveryJob>(COMMANDS.retryNow, { jobId }),
  },

  insights: {
    listInsights: () => invoke<Insight[]>(COMMANDS.listInsights),
  },

  playbooks: {
    listPlaybooks: () => invoke<Playbook[]>(COMMANDS.listPlaybooks),
    setPlaybookEnabled: (playbookId, enabled) =>
      invoke<Playbook>(COMMANDS.setPlaybookEnabled, { playbookId, enabled }),
  },

  audit: {
    listEvents: (query) => invoke<Paged<AuditEvent>>(COMMANDS.listAuditEvents, { query }),
  },

  system: {
    getEngineStatus: () => invoke<EngineStatus>(COMMANDS.engineStatus),
    getMerchant: () => invoke<Merchant>(COMMANDS.merchant),
  },
};
