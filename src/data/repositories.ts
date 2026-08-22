import type {
  AttemptEffectiveness,
  AuditEvent,
  AuditSeverity,
  DashboardMetrics,
  EngineStatus,
  FailureBreakdown,
  Insight,
  Merchant,
  MethodBreakdown,
  Paged,
  Playbook,
  QueueFilters,
  RecoveryJob,
  TrendPoint,
} from '@/domain';

/**
 * Ports the UI talks to. Two adapters implement these: a development seed
 * adapter, and the Tauri adapter that calls into the Rust recovery engine.
 * No component imports an adapter directly -- see `@/data`.
 */

export type JobSort = 'recent' | 'amount_desc' | 'score_desc' | 'sla_soonest';

export interface PageRequest {
  offset: number;
  limit: number;
  /** Defaults to `recent`. Sorting happens in the data layer, not the table. */
  sort?: JobSort;
}

export interface AuditQuery extends PageRequest {
  severities: AuditSeverity[];
  search: string;
  jobId?: string;
}

export interface MetricsRepository {
  getDashboardMetrics(windowDays: number): Promise<DashboardMetrics>;
  getTrend(windowDays: number): Promise<TrendPoint[]>;
  getFailureBreakdown(windowDays: number): Promise<FailureBreakdown[]>;
  getMethodBreakdown(windowDays: number): Promise<MethodBreakdown[]>;
  getAttemptEffectiveness(windowDays: number): Promise<AttemptEffectiveness[]>;
}

export interface RecoveryRepository {
  listJobs(filters: QueueFilters, page: PageRequest): Promise<Paged<RecoveryJob>>;
  getJob(jobId: string): Promise<RecoveryJob | null>;
  /** Human confirms the engine's recommendation; schedules it immediately. */
  approveRecommendedAction(jobId: string): Promise<RecoveryJob>;
  /** Human stops all automation for this job. */
  suppressJob(jobId: string, reason: string): Promise<RecoveryJob>;
  /** Human forces the next attempt now, skipping any delay. */
  retryNow(jobId: string): Promise<RecoveryJob>;
}

export interface InsightRepository {
  listInsights(): Promise<Insight[]>;
}

export interface PlaybookRepository {
  listPlaybooks(): Promise<Playbook[]>;
  setPlaybookEnabled(playbookId: string, enabled: boolean): Promise<Playbook>;
}

export interface AuditRepository {
  listEvents(query: AuditQuery): Promise<Paged<AuditEvent>>;
}

export interface SystemRepository {
  getEngineStatus(): Promise<EngineStatus>;
  getMerchant(): Promise<Merchant>;
}

export interface DataSource {
  metrics: MetricsRepository;
  recovery: RecoveryRepository;
  insights: InsightRepository;
  playbooks: PlaybookRepository;
  audit: AuditRepository;
  system: SystemRepository;
}
