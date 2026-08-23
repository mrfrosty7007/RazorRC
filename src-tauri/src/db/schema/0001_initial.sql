-- ReviveAI recovery store, migration 0001.
--
-- Shape notes that apply to the whole schema:
--
--   * Money is an INTEGER count of paise, never a float. ₹1,234.50 is 123450.
--     Rounding errors in a recovery ledger are indefensible, and SQLite has no
--     decimal type, so integers it is.
--   * Timestamps are fixed-width ISO-8601 UTC TEXT (see `src/clock.rs`). That
--     makes `>=` range scans and `substr(t, 1, 10)` day-bucketing correct
--     without a date type.
--   * Enumerated columns store the same string the JSON API uses, enforced by
--     CHECK constraints generated from the same literals as the Rust enums in
--     `src/domain.rs`. A typo in a status is a constraint violation at write
--     time rather than a row that quietly stops matching every filter.
--   * `audit_events` is append-only. Nothing in this application issues an
--     UPDATE or DELETE against it; that is the point of having it.

-- ---------------------------------------------------------------------------
-- Customers
-- ---------------------------------------------------------------------------

CREATE TABLE customers (
  id                    TEXT    PRIMARY KEY,
  name                  TEXT    NOT NULL,
  email                 TEXT    NOT NULL,
  -- Masked before it reaches this table. ReviveAI has no reason to hold a
  -- full contact number, so it does not.
  phone_masked          TEXT    NOT NULL,
  lifetime_value_paise  INTEGER NOT NULL DEFAULT 0 CHECK (lifetime_value_paise >= 0),
  successful_payments   INTEGER NOT NULL DEFAULT 0 CHECK (successful_payments >= 0)
) STRICT;

-- ---------------------------------------------------------------------------
-- Failed payments, as ingested from Razorpay
-- ---------------------------------------------------------------------------

CREATE TABLE failed_payments (
  id                  TEXT    PRIMARY KEY,
  -- `pay_...`, unique per attempt. The UNIQUE constraint is what makes webhook
  -- redelivery safe: Razorpay retries `payment.failed`, and `jobs::ingest`
  -- checks this column — and the primary key, which a redelivery also repeats —
  -- before writing. Deliberately not an `INSERT OR IGNORE`: that would absorb
  -- every CHECK below as well, and report a dropped payment as a duplicate.
  razorpay_payment_id TEXT    NOT NULL UNIQUE,
  -- `order_...`, stable across retries of the same order.
  razorpay_order_id   TEXT    NOT NULL,
  customer_id         TEXT    NOT NULL REFERENCES customers (id) ON DELETE RESTRICT,
  amount_paise        INTEGER NOT NULL CHECK (amount_paise > 0),
  method              TEXT    NOT NULL CHECK (
                        method IN ('card', 'upi', 'netbanking', 'wallet', 'emandate', 'emi')
                      ),
  card_network        TEXT,
  issuer              TEXT,
  failure_reason      TEXT    NOT NULL CHECK (
                        failure_reason IN (
                          'insufficient_funds', 'card_expired', 'invalid_card',
                          'do_not_honour', 'authentication_timeout', 'bank_downtime',
                          'upi_collect_expired', 'mandate_revoked', 'limit_exceeded',
                          'gateway_timeout'
                        )
                      ),
  -- Verbatim gateway text. Kept unedited so a human always has ground truth to
  -- check the engine's classification against.
  gateway_description TEXT    NOT NULL,
  failed_at           TEXT    NOT NULL,
  attempt_count       INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count >= 1),
  is_subscription     INTEGER NOT NULL DEFAULT 0 CHECK (is_subscription IN (0, 1))
) STRICT;

CREATE INDEX idx_failed_payments_failed_at ON failed_payments (failed_at DESC);
CREATE INDEX idx_failed_payments_order ON failed_payments (razorpay_order_id);
CREATE INDEX idx_failed_payments_customer ON failed_payments (customer_id);

-- ---------------------------------------------------------------------------
-- Recovery jobs: one per failed payment, carrying the engine's decision
-- ---------------------------------------------------------------------------

CREATE TABLE recovery_jobs (
  id                     TEXT    PRIMARY KEY,
  payment_id             TEXT    NOT NULL UNIQUE
                                 REFERENCES failed_payments (id) ON DELETE CASCADE,
  status                 TEXT    NOT NULL CHECK (
                           status IN (
                             'queued', 'scheduled', 'in_progress', 'awaiting_customer',
                             'recovered', 'failed', 'written_off', 'suppressed'
                           )
                         ),
  risk_tier              TEXT    NOT NULL CHECK (
                           risk_tier IN ('critical', 'high', 'medium', 'low')
                         ),
  recovery_score         REAL    NOT NULL CHECK (recovery_score BETWEEN 0 AND 1),

  -- The recommended action, denormalised onto the job. It is a property of this
  -- decision at this moment, not a shared entity: re-scoring writes a new
  -- action and an audit event, and the old one stays in the trail.
  action_kind            TEXT    NOT NULL CHECK (
                           action_kind IN (
                             'auto_retry', 'retry_on_payday', 'retry_after_downtime',
                             'switch_to_upi', 'request_card_update', 'send_payment_link',
                             'dunning_email', 'dunning_whatsapp', 'human_review'
                           )
                         ),
  action_label           TEXT    NOT NULL,
  action_channel         TEXT    NOT NULL CHECK (
                           action_channel IN ('gateway', 'email', 'whatsapp', 'sms', 'in_app')
                         ),
  action_confidence      REAL    NOT NULL CHECK (action_confidence BETWEEN 0 AND 1),
  action_delay_minutes   INTEGER NOT NULL DEFAULT 0 CHECK (action_delay_minutes >= 0),
  -- JSON array of `{ label, weight, detail }`. Stored as a document because it
  -- is only ever read whole, alongside the job, to render "Why this action".
  action_signals         TEXT    NOT NULL DEFAULT '[]',

  next_action_at         TEXT,
  recovered_amount_paise INTEGER CHECK (
                           recovered_amount_paise IS NULL OR recovered_amount_paise > 0
                         ),
  -- Recovery windows close: mandates lapse, carts go cold.
  sla_expires_at         TEXT    NOT NULL,
  created_at             TEXT    NOT NULL,
  updated_at             TEXT    NOT NULL,
  -- Set when a human took the job off the engine.
  assigned_to            TEXT,

  -- Money can only be marked recovered by a job that says it recovered.
  CHECK (
    (status = 'recovered' AND recovered_amount_paise IS NOT NULL)
    OR (status <> 'recovered' AND recovered_amount_paise IS NULL)
  ),
  -- A closed job has nothing pending. Without this, a written-off job can keep
  -- a live `next_action_at` and the sweep will pick it up forever.
  CHECK (
    next_action_at IS NULL
    OR status IN ('queued', 'scheduled', 'in_progress', 'awaiting_customer')
  )
) STRICT;

CREATE INDEX idx_recovery_jobs_status ON recovery_jobs (status);
CREATE INDEX idx_recovery_jobs_score ON recovery_jobs (recovery_score DESC);
CREATE INDEX idx_recovery_jobs_sla ON recovery_jobs (sla_expires_at);
-- The sweep's hot query: due actions, oldest first.
CREATE INDEX idx_recovery_jobs_due ON recovery_jobs (next_action_at)
  WHERE next_action_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Attempts: what was actually tried, in order
-- ---------------------------------------------------------------------------

CREATE TABLE recovery_attempts (
  id          TEXT    PRIMARY KEY,
  job_id      TEXT    NOT NULL REFERENCES recovery_jobs (id) ON DELETE CASCADE,
  sequence    INTEGER NOT NULL CHECK (sequence >= 1),
  kind        TEXT    NOT NULL CHECK (
                kind IN (
                  'auto_retry', 'retry_on_payday', 'retry_after_downtime',
                  'switch_to_upi', 'request_card_update', 'send_payment_link',
                  'dunning_email', 'dunning_whatsapp', 'human_review'
                )
              ),
  channel     TEXT    NOT NULL CHECK (
                channel IN ('gateway', 'email', 'whatsapp', 'sms', 'in_app')
              ),
  occurred_at TEXT    NOT NULL,
  outcome     TEXT    NOT NULL CHECK (
                outcome IN ('succeeded', 'failed', 'pending', 'skipped', 'delivered')
              ),
  -- Gateway or provider response, kept for the audit trail.
  note        TEXT    NOT NULL DEFAULT '',

  UNIQUE (job_id, sequence)
) STRICT;

CREATE INDEX idx_recovery_attempts_job ON recovery_attempts (job_id, sequence);
CREATE INDEX idx_recovery_attempts_occurred ON recovery_attempts (occurred_at DESC);

-- ---------------------------------------------------------------------------
-- Playbooks: merchant-editable rule sets
-- ---------------------------------------------------------------------------

CREATE TABLE playbooks (
  id                   TEXT    PRIMARY KEY,
  ordinal              INTEGER NOT NULL,
  name                 TEXT    NOT NULL,
  description          TEXT    NOT NULL,
  enabled              INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  -- JSON: `{ reasons, methods, minAmountPaise, subscriptionOnly }`.
  trigger_json         TEXT    NOT NULL,
  -- JSON array of `{ sequence, kind, delayMinutes, stopOnSuccess }`.
  steps_json           TEXT    NOT NULL,
  -- Rolled forward by the engine as jobs close, so the list can be read without
  -- re-aggregating the whole job table on every render.
  stats_jobs_matched   INTEGER NOT NULL DEFAULT 0 CHECK (stats_jobs_matched >= 0),
  stats_recovered_paise INTEGER NOT NULL DEFAULT 0 CHECK (stats_recovered_paise >= 0),
  stats_recovery_rate  REAL    NOT NULL DEFAULT 0 CHECK (stats_recovery_rate BETWEEN 0 AND 1),
  updated_at           TEXT    NOT NULL
) STRICT;

CREATE INDEX idx_playbooks_ordinal ON playbooks (ordinal);

-- ---------------------------------------------------------------------------
-- Audit trail: append-only
-- ---------------------------------------------------------------------------

CREATE TABLE audit_events (
  id            TEXT PRIMARY KEY,
  at            TEXT NOT NULL,
  actor_type    TEXT NOT NULL CHECK (actor_type IN ('engine', 'user', 'webhook', 'system')),
  actor_name    TEXT NOT NULL,
  -- Dotted machine action, e.g. `job.retry.scheduled`.
  action        TEXT NOT NULL,
  -- Human sentence for the same thing. Searched by the audit screen.
  summary       TEXT NOT NULL,
  severity      TEXT NOT NULL CHECK (severity IN ('info', 'notice', 'warning', 'critical')),
  -- Nullable: sweeps and credential changes are not job-scoped. Deliberately
  -- NOT a foreign key — the trail has to outlive the rows it describes.
  job_id        TEXT,
  -- JSON object of flat string values, rendered as a definition list.
  metadata_json TEXT NOT NULL DEFAULT '{}'
) STRICT;

CREATE INDEX idx_audit_events_at ON audit_events (at DESC);
CREATE INDEX idx_audit_events_job ON audit_events (job_id) WHERE job_id IS NOT NULL;
CREATE INDEX idx_audit_events_severity ON audit_events (severity, at DESC);

-- Refuse to rewrite history. An audit trail that can be edited is decoration,
-- so the guarantee is enforced by the database rather than by convention.
CREATE TRIGGER audit_events_are_immutable
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;

CREATE TRIGGER audit_events_cannot_be_deleted
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;
