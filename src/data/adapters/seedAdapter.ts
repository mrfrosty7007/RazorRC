import type {
  AuditEvent,
  DashboardMetrics,
  EngineStatus,
  Insight,
  Merchant,
  Paged,
  Playbook,
  QueueFilters,
  RecoveryJob,
} from '@/domain';
import type {
  AuditQuery,
  DataSource,
  JobSort,
  PageRequest,
} from '../repositories';
import {
  MERCHANT,
  PLAYBOOKS,
  buildAttemptEffectiveness,
  buildAuditEvents,
  buildEngineStatus,
  buildFailureBreakdown,
  buildInsights,
  buildMethodBreakdown,
  buildMetrics,
  buildTrend,
  JOBS,
} from '../seed/fixtures';

/**
 * Development adapter. Serves the seeded dataset with a small artificial
 * latency so loading and empty states are exercised during development rather
 * than only in production.
 *
 * Mutations are applied to an in-memory store, and every read — metrics,
 * trend, analytics, insights included — is derived from that store rather than
 * from the original fixture. Approving an action really does move the row and
 * really does move the dashboard, so the UI is never more optimistic here than
 * it is against the Rust engine.
 *
 * Reads hand back structural copies, the way the Tauri bridge does when it
 * serialises a command result. Without that, a component could mutate the
 * store in place and the seed build would quietly behave differently from the
 * packaged app.
 */

const LATENCY_MS = 220;

function settle<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(structuredClone(value)), LATENCY_MS));
}

let jobs: RecoveryJob[] = [...JOBS];
let playbooks: Playbook[] = [...PLAYBOOKS];
let auditEvents: AuditEvent[] = buildAuditEvents(jobs);
let eventSequence = 0;

function updateJob(jobId: string, patch: Partial<RecoveryJob>): RecoveryJob {
  const current = jobs.find((j) => j.id === jobId);
  if (!current) throw new Error(`No recovery job with id ${jobId}`);

  const next: RecoveryJob = { ...current, ...patch, updatedAt: new Date().toISOString() };
  jobs = jobs.map((j) => (j.id === jobId ? next : j));
  return next;
}

function record(event: Omit<AuditEvent, 'id' | 'at'>): void {
  eventSequence += 1;
  auditEvents = [
    { ...event, id: `evt_local_${eventSequence}`, at: new Date().toISOString() },
    ...auditEvents,
  ];
}

function matchesFilters(job: RecoveryJob, filters: QueueFilters): boolean {
  if (filters.statuses.length && !filters.statuses.includes(job.status)) return false;
  if (filters.reasons.length && !filters.reasons.includes(job.payment.failureReason)) return false;
  if (filters.methods.length && !filters.methods.includes(job.payment.method)) return false;
  if (filters.riskTiers.length && !filters.riskTiers.includes(job.riskTier)) return false;

  const needle = filters.search.trim().toLowerCase();
  if (!needle) return true;

  return [
    job.payment.customer.name,
    job.payment.customer.email,
    job.payment.razorpayPaymentId,
    job.payment.razorpayOrderId,
  ].some((field) => field.toLowerCase().includes(needle));
}

/** Ordering belongs to the data layer so paging stays correct across pages. */
function sortJobs(rows: RecoveryJob[], sort: JobSort = 'recent'): RecoveryJob[] {
  const sorted = [...rows];

  switch (sort) {
    case 'amount_desc':
      return sorted.sort((a, b) => b.payment.amountPaise - a.payment.amountPaise);
    case 'score_desc':
      return sorted.sort((a, b) => b.recoveryScore - a.recoveryScore);
    case 'sla_soonest':
      return sorted.sort((a, b) => a.slaExpiresAt.localeCompare(b.slaExpiresAt));
    case 'recent':
      return sorted.sort((a, b) => b.payment.failedAt.localeCompare(a.payment.failedAt));
  }
}

export const seedAdapter: DataSource = {
  metrics: {
    getDashboardMetrics: (windowDays: number): Promise<DashboardMetrics> =>
      settle(buildMetrics(jobs, windowDays)),
    getTrend: (windowDays) => settle(buildTrend(jobs, windowDays)),
    getFailureBreakdown: (windowDays) => settle(buildFailureBreakdown(jobs, windowDays)),
    getMethodBreakdown: (windowDays) => settle(buildMethodBreakdown(jobs, windowDays)),
    getAttemptEffectiveness: (windowDays) => settle(buildAttemptEffectiveness(jobs, windowDays)),
  },

  recovery: {
    listJobs: (filters: QueueFilters, page: PageRequest): Promise<Paged<RecoveryJob>> => {
      const matched = sortJobs(
        jobs.filter((job) => matchesFilters(job, filters)),
        page.sort,
      );
      return settle({
        rows: matched.slice(page.offset, page.offset + page.limit),
        total: matched.length,
      });
    },

    getJob: (jobId) => settle(jobs.find((j) => j.id === jobId) ?? null),

    // Mutations are `async` so a missing id rejects the promise rather than
    // throwing before one exists: a caller that only attaches `.catch` would
    // otherwise take the whole page down.
    approveRecommendedAction: async (jobId) => {
      const current = jobs.find((j) => j.id === jobId);
      if (!current) throw new Error(`No recovery job with id ${jobId}`);

      const job = updateJob(jobId, {
        status: 'scheduled',
        nextActionAt: new Date(
          Date.now() + current.recommendedAction.delayMinutes * 60_000,
        ).toISOString(),
      });
      record({
        actor: { type: 'user', name: 'You' },
        action: 'job.action.approved',
        summary: `Approved "${job.recommendedAction.label}" for ${job.payment.customer.name}`,
        severity: 'notice',
        jobId,
        metadata: { action: job.recommendedAction.kind, channel: job.recommendedAction.channel },
      });
      return settle(job);
    },

    suppressJob: async (jobId, reason) => {
      const job = updateJob(jobId, { status: 'suppressed', nextActionAt: null });
      record({
        actor: { type: 'user', name: 'You' },
        action: 'job.suppressed',
        summary: `Stopped automation for ${job.payment.customer.name}`,
        severity: 'warning',
        jobId,
        metadata: { reason },
      });
      return settle(job);
    },

    retryNow: async (jobId) => {
      const job = updateJob(jobId, {
        status: 'in_progress',
        nextActionAt: new Date().toISOString(),
      });
      record({
        actor: { type: 'user', name: 'You' },
        action: 'job.retry.forced',
        summary: `Forced an immediate retry for ${job.payment.customer.name}`,
        severity: 'notice',
        jobId,
        metadata: { amount_paise: String(job.payment.amountPaise) },
      });
      return settle(job);
    },
  },

  insights: {
    listInsights: (): Promise<Insight[]> => settle(buildInsights(jobs)),
  },

  playbooks: {
    listPlaybooks: () => settle(playbooks),
    setPlaybookEnabled: async (playbookId, enabled) => {
      const current = playbooks.find((p) => p.id === playbookId);
      if (!current) throw new Error(`No playbook with id ${playbookId}`);

      const next: Playbook = { ...current, enabled, updatedAt: new Date().toISOString() };
      playbooks = playbooks.map((p) => (p.id === playbookId ? next : p));
      record({
        actor: { type: 'user', name: 'You' },
        action: enabled ? 'playbook.enabled' : 'playbook.disabled',
        summary: `${enabled ? 'Enabled' : 'Disabled'} the "${next.name}" playbook`,
        severity: 'warning',
        jobId: null,
        metadata: { playbook_id: playbookId },
      });
      return settle(next);
    },
  },

  audit: {
    listEvents: (query: AuditQuery): Promise<Paged<AuditEvent>> => {
      const needle = query.search.trim().toLowerCase();
      const matched = auditEvents.filter((event) => {
        if (query.severities.length && !query.severities.includes(event.severity)) return false;
        if (query.jobId && event.jobId !== query.jobId) return false;
        if (!needle) return true;
        return (
          event.summary.toLowerCase().includes(needle) ||
          event.action.toLowerCase().includes(needle) ||
          event.actor.name.toLowerCase().includes(needle)
        );
      });

      return settle({
        rows: matched.slice(query.offset, query.offset + query.limit),
        total: matched.length,
      });
    },
  },

  system: {
    getEngineStatus: (): Promise<EngineStatus> => settle(buildEngineStatus(jobs)),
    getMerchant: (): Promise<Merchant> => settle(MERCHANT),
  },
};
