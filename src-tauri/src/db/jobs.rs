//! Recovery queue reads and state transitions.
//!
//! Every mutation here does three things in one transaction: change the job,
//! append an audit event, and refuse the change outright if the job is already
//! closed. Doing them together is what makes the trail trustworthy — a job that
//! moved without a matching event, or an event describing a move that was rolled
//! back, are both worse than an error message.

use std::collections::HashMap;

use rusqlite::{params, params_from_iter, types::Value, Connection, Row, Transaction};

use crate::clock;
use crate::db::{self, audit, like_pattern, placeholders};
use crate::domain::{
    Actor, AuditSeverity, CustomerRef, FailedPayment, PageRequest, Paged, QueueFilters,
    RecoveryAction, RecoveryActionKind, RecoveryAttempt, RecoveryJob, RecoveryStatus,
};
use crate::error::{EngineError, EngineResult};
use crate::recovery::rules;

/// One place where the join and its aliases are written. Reads use column names
/// rather than indices so adding a column cannot silently shift every field.
const SELECT_JOB: &str = "SELECT
     j.id AS job_id, j.status, j.risk_tier, j.recovery_score,
     j.action_kind, j.action_label, j.action_channel, j.action_confidence,
     j.action_delay_minutes, j.action_signals,
     j.next_action_at, j.recovered_amount_paise, j.sla_expires_at,
     j.created_at, j.updated_at, j.assigned_to,
     p.id AS payment_id, p.razorpay_payment_id, p.razorpay_order_id,
     p.amount_paise, p.method, p.card_network, p.issuer, p.failure_reason,
     p.gateway_description, p.failed_at, p.attempt_count, p.is_subscription,
     c.id AS customer_id, c.name AS customer_name, c.email AS customer_email,
     c.phone_masked, c.lifetime_value_paise, c.successful_payments
   FROM recovery_jobs j
   JOIN failed_payments p ON p.id = j.payment_id
   JOIN customers c ON c.id = p.customer_id";

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

pub fn list(
    connection: &Connection,
    filters: &QueueFilters,
    page: &PageRequest,
) -> EngineResult<Paged<RecoveryJob>> {
    let (clause, mut values) = filter_clause(filters);

    let total: i64 = connection.query_row(
        &format!(
            "SELECT COUNT(*)
               FROM recovery_jobs j
               JOIN failed_payments p ON p.id = j.payment_id
               JOIN customers c ON c.id = p.customer_id
               {clause}"
        ),
        params_from_iter(values.iter()),
        |row| row.get(0),
    )?;

    if total == 0 {
        return Ok(Paged::empty());
    }

    let sql = format!(
        "{SELECT_JOB} {clause} ORDER BY {} LIMIT ? OFFSET ?",
        page.sort().order_by()
    );
    values.push(Value::Integer(page.limit()));
    values.push(Value::Integer(page.offset()));

    let mut statement = connection.prepare(&sql)?;
    let mut rows = statement.query(params_from_iter(values.iter()))?;

    let mut jobs = Vec::new();
    while let Some(row) = rows.next()? {
        jobs.push(read_job(row)?);
    }

    attach_attempts(connection, &mut jobs)?;
    Ok(Paged::new(jobs, total))
}

/// `None` rather than an error for a missing id: the UI opens jobs from deep
/// links, and a stale link is a normal thing to happen, not a failure.
pub fn get(connection: &Connection, job_id: &str) -> EngineResult<Option<RecoveryJob>> {
    let mut statement = connection.prepare(&format!("{SELECT_JOB} WHERE j.id = ?1"))?;
    let mut rows = statement.query(params![job_id])?;

    let Some(row) = rows.next()? else {
        return Ok(None);
    };

    let mut jobs = vec![read_job(row)?];
    drop(rows);
    attach_attempts(connection, &mut jobs)?;
    Ok(jobs.pop())
}

/// Jobs whose scheduled action is due at or before `cutoff`, oldest first.
pub fn due(connection: &Connection, cutoff: &str, limit: i64) -> EngineResult<Vec<String>> {
    let mut statement = connection.prepare(
        "SELECT id FROM recovery_jobs
          WHERE next_action_at IS NOT NULL
            AND next_action_at <= ?1
            AND status IN ('queued', 'scheduled')
          ORDER BY next_action_at ASC
          LIMIT ?2",
    )?;

    let mut rows = statement.query(params![cutoff, limit])?;

    let mut ids = Vec::new();
    while let Some(row) = rows.next()? {
        ids.push(row.get::<_, String>(0)?);
    }
    Ok(ids)
}

pub fn count_by_status(connection: &Connection, statuses: &[RecoveryStatus]) -> EngineResult<i64> {
    if statuses.is_empty() {
        return Ok(0);
    }

    let sql = format!(
        "SELECT COUNT(*) FROM recovery_jobs WHERE status IN ({})",
        placeholders(statuses.len())
    );
    let values: Vec<Value> = statuses
        .iter()
        .map(|status| Value::Text(status.as_str().to_string()))
        .collect();

    let count = connection.query_row(&sql, params_from_iter(values.iter()), |row| row.get(0))?;
    Ok(count)
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

/// Records a failed payment and the engine's decision about it.
///
/// Idempotent on `razorpay_payment_id`, because Razorpay redelivers webhooks and
/// a double-ingest would mean a second recovery job chasing the same rupees.
/// Returns the job id, or `None` when the payment was already known.
pub fn ingest(
    transaction: &Transaction<'_>,
    payment: &FailedPayment,
    actor: Actor,
) -> EngineResult<Option<String>> {
    let inserted = transaction.execute(
        "INSERT OR IGNORE INTO customers
           (id, name, email, phone_masked, lifetime_value_paise, successful_payments)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            payment.customer.id,
            payment.customer.name,
            payment.customer.email,
            payment.customer.phone_masked,
            payment.customer.lifetime_value_paise,
            payment.customer.successful_payments,
        ],
    )?;

    if inserted == 0 {
        // Known customer: keep the value counters current, they feed scoring.
        transaction.execute(
            "UPDATE customers
                SET lifetime_value_paise = ?2, successful_payments = ?3
              WHERE id = ?1",
            params![
                payment.customer.id,
                payment.customer.lifetime_value_paise,
                payment.customer.successful_payments,
            ],
        )?;
    }

    let new_payment = transaction.execute(
        "INSERT OR IGNORE INTO failed_payments
           (id, razorpay_payment_id, razorpay_order_id, customer_id, amount_paise, method,
            card_network, issuer, failure_reason, gateway_description, failed_at,
            attempt_count, is_subscription)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            payment.id,
            payment.razorpay_payment_id,
            payment.razorpay_order_id,
            payment.customer.id,
            payment.amount_paise,
            payment.method,
            payment.card_network,
            payment.issuer,
            payment.failure_reason,
            payment.gateway_description,
            payment.failed_at,
            payment.attempt_count,
            payment.is_subscription,
        ],
    )?;

    if new_payment == 0 {
        return Ok(None);
    }

    let (scored, action) = rules::evaluate(payment)?;
    let sla_minutes = rules::sla_minutes(payment, &action);
    let failed_at = clock::parse_iso(&payment.failed_at)?;
    let now = clock::now_iso();

    let job_id = job_id_for(&payment.id);
    let signals =
        serde_json::to_string(&action.signals).map_err(|cause| EngineError::json(&job_id, cause))?;

    transaction.execute(
        "INSERT INTO recovery_jobs
           (id, payment_id, status, risk_tier, recovery_score,
            action_kind, action_label, action_channel, action_confidence,
            action_delay_minutes, action_signals, next_action_at,
            recovered_amount_paise, sla_expires_at, created_at, updated_at, assigned_to)
         VALUES (?1, ?2, 'queued', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL, ?12, ?13, ?13, NULL)",
        params![
            job_id,
            payment.id,
            scored.risk_tier,
            scored.score,
            action.kind,
            action.label,
            action.channel,
            action.confidence,
            action.delay_minutes,
            signals,
            clock::to_iso(clock::plus_minutes(failed_at, action.delay_minutes)),
            clock::to_iso(clock::plus_minutes(failed_at, sla_minutes)),
            now,
        ],
    )?;

    audit::record(
        transaction,
        &audit::event(
            actor,
            "job.scored",
            format!(
                "Scored {} at {}% and queued “{}”",
                payment.razorpay_payment_id,
                (scored.score * 100.0).round() as i64,
                action.label
            ),
            AuditSeverity::Info,
            Some(job_id.clone()),
            audit::meta([
                ("reason", payment.failure_reason.to_string()),
                ("action", action.kind.to_string()),
                ("amountPaise", payment.amount_paise.to_string()),
            ]),
        ),
    )?;

    Ok(Some(job_id))
}

/// `fp_0001` becomes `job_0001`, so an id in the audit trail can be read across
/// the two tables without a lookup.
pub fn job_id_for(payment_id: &str) -> String {
    let suffix = payment_id.strip_prefix("fp_").unwrap_or(payment_id);
    format!("job_{suffix}")
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/// Accepts the engine's recommendation: the action moves from "suggested" to
/// "scheduled", timed from now rather than from the original failure.
pub fn approve(
    transaction: &Transaction<'_>,
    job_id: &str,
    operator: &str,
) -> EngineResult<RecoveryJob> {
    let job = require_open(transaction, job_id, "approved")?;
    let fires_at = clock::iso_minutes_from_now(job.recommended_action.delay_minutes);

    transaction.execute(
        "UPDATE recovery_jobs
            SET status = 'scheduled', next_action_at = ?2, updated_at = ?3
          WHERE id = ?1",
        params![job_id, fires_at, clock::now_iso()],
    )?;

    audit::record(
        transaction,
        &audit::event(
            Actor::operator(operator),
            "job.action.approved",
            format!("Approved “{}”", job.recommended_action.label),
            AuditSeverity::Notice,
            Some(job_id.to_string()),
            audit::meta([
                ("action", job.recommended_action.kind.to_string()),
                ("channel", job.recommended_action.channel.to_string()),
                ("firesAt", fires_at.clone()),
            ]),
        ),
    )?;

    reload(transaction, job_id)
}

/// Takes a job out of recovery for good. Requires a reason: a suppression with
/// no stated cause is the one audit row nobody can defend later.
pub fn suppress(
    transaction: &Transaction<'_>,
    job_id: &str,
    reason: &str,
    operator: &str,
) -> EngineResult<RecoveryJob> {
    let reason = reason.trim();
    if reason.is_empty() {
        return Err(EngineError::Rejected(
            "a suppression needs a reason so the audit trail can explain it".to_string(),
        ));
    }

    require_open(transaction, job_id, "suppressed")?;

    transaction.execute(
        "UPDATE recovery_jobs
            SET status = 'suppressed', next_action_at = NULL,
                assigned_to = ?2, updated_at = ?3
          WHERE id = ?1",
        params![job_id, operator, clock::now_iso()],
    )?;

    audit::record(
        transaction,
        &audit::event(
            Actor::operator(operator),
            "job.suppressed",
            format!("Suppressed recovery: {reason}"),
            AuditSeverity::Warning,
            Some(job_id.to_string()),
            audit::meta([("reason", reason)]),
        ),
    )?;

    reload(transaction, job_id)
}

/// Runs the recommended action immediately, logging the attempt as `pending`.
///
/// Phase 1 registers no Razorpay transport, so the attempt stays pending until
/// one is wired in. That is deliberately visible in the UI rather than being
/// reported as a success that never happened.
pub fn retry_now(
    transaction: &Transaction<'_>,
    job_id: &str,
    operator: &str,
) -> EngineResult<RecoveryJob> {
    let job = require_open(transaction, job_id, "retried")?;
    let now = clock::now_iso();
    let sequence = next_sequence(transaction, job_id)?;

    transaction.execute(
        "INSERT INTO recovery_attempts
           (id, job_id, sequence, kind, channel, occurred_at, outcome, note)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7)",
        params![
            db::attempt_id(job_id, sequence),
            job_id,
            sequence,
            job.recommended_action.kind,
            job.recommended_action.channel,
            now,
            format!("Started by {operator} from the recovery queue"),
        ],
    )?;

    transaction.execute(
        "UPDATE recovery_jobs
            SET status = 'in_progress', next_action_at = ?2,
                assigned_to = ?3, updated_at = ?2
          WHERE id = ?1",
        params![job_id, now, operator],
    )?;

    audit::record(
        transaction,
        &audit::event(
            Actor::operator(operator),
            "job.retry.started",
            format!("Ran “{}” immediately", job.recommended_action.label),
            AuditSeverity::Notice,
            Some(job_id.to_string()),
            audit::meta([
                ("action", job.recommended_action.kind.to_string()),
                ("attempt", sequence.to_string()),
            ]),
        ),
    )?;

    reload(transaction, job_id)
}

/// The sweep's transition: a due job becomes work in progress.
pub fn start_due_job(transaction: &Transaction<'_>, job_id: &str) -> EngineResult<()> {
    let job = require_open(transaction, job_id, "started")?;
    let now = clock::now_iso();
    let sequence = next_sequence(transaction, job_id)?;

    transaction.execute(
        "INSERT INTO recovery_attempts
           (id, job_id, sequence, kind, channel, occurred_at, outcome, note)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', 'Picked up by the scheduled sweep')",
        params![
            db::attempt_id(job_id, sequence),
            job_id,
            sequence,
            job.recommended_action.kind,
            job.recommended_action.channel,
            now,
        ],
    )?;

    transaction.execute(
        "UPDATE recovery_jobs
            SET status = 'in_progress', next_action_at = ?2, updated_at = ?2
          WHERE id = ?1",
        params![job_id, now],
    )?;

    audit::record(
        transaction,
        &audit::event(
            Actor::scheduler(),
            "job.action.due",
            format!("Action “{}” came due", job.recommended_action.label),
            AuditSeverity::Info,
            Some(job_id.to_string()),
            audit::meta([("attempt", sequence.to_string())]),
        ),
    )?;

    Ok(())
}

fn require_open(
    connection: &Connection,
    job_id: &str,
    verb: &str,
) -> EngineResult<RecoveryJob> {
    let job = get(connection, job_id)?.ok_or_else(|| EngineError::UnknownJob(job_id.to_string()))?;

    if job.status.is_closed() {
        return Err(EngineError::Rejected(format!(
            "job {job_id} is {} and cannot be {verb}",
            job.status
        )));
    }

    Ok(job)
}

fn reload(connection: &Connection, job_id: &str) -> EngineResult<RecoveryJob> {
    get(connection, job_id)?.ok_or_else(|| EngineError::UnknownJob(job_id.to_string()))
}

fn next_sequence(connection: &Connection, job_id: &str) -> EngineResult<i64> {
    let highest: Option<i64> = connection.query_row(
        "SELECT MAX(sequence) FROM recovery_attempts WHERE job_id = ?1",
        params![job_id],
        |row| row.get(0),
    )?;
    Ok(highest.unwrap_or(0) + 1)
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

fn filter_clause(filters: &QueueFilters) -> (String, Vec<Value>) {
    let mut clauses: Vec<String> = Vec::new();
    let mut values: Vec<Value> = Vec::new();

    // Enumerated filters are bound as parameters even though they arrive as
    // parsed enums. Interpolating them would work right up until someone
    // relaxes the type on the way in.
    if !filters.statuses.is_empty() {
        clauses.push(format!(
            "j.status IN ({})",
            placeholders(filters.statuses.len())
        ));
        values.extend(filters.statuses.iter().map(text));
    }

    if !filters.reasons.is_empty() {
        clauses.push(format!(
            "p.failure_reason IN ({})",
            placeholders(filters.reasons.len())
        ));
        values.extend(filters.reasons.iter().map(text));
    }

    if !filters.methods.is_empty() {
        clauses.push(format!(
            "p.method IN ({})",
            placeholders(filters.methods.len())
        ));
        values.extend(filters.methods.iter().map(text));
    }

    if !filters.risk_tiers.is_empty() {
        clauses.push(format!(
            "j.risk_tier IN ({})",
            placeholders(filters.risk_tiers.len())
        ));
        values.extend(filters.risk_tiers.iter().map(text));
    }

    let search = filters.search.trim();
    if !search.is_empty() {
        clauses.push(
            "(c.name LIKE ? ESCAPE '\\'
              OR c.email LIKE ? ESCAPE '\\'
              OR p.razorpay_payment_id LIKE ? ESCAPE '\\'
              OR p.razorpay_order_id LIKE ? ESCAPE '\\'
              OR j.id LIKE ? ESCAPE '\\')"
                .to_string(),
        );
        let pattern = like_pattern(search);
        for _ in 0..5 {
            values.push(Value::Text(pattern.clone()));
        }
    }

    if clauses.is_empty() {
        (String::new(), values)
    } else {
        (format!("WHERE {}", clauses.join(" AND ")), values)
    }
}

fn text<T: std::fmt::Display>(value: &T) -> Value {
    Value::Text(value.to_string())
}

fn read_job(row: &Row<'_>) -> EngineResult<RecoveryJob> {
    let job_id: String = row.get("job_id")?;
    let signals_json: String = row.get("action_signals")?;
    let signals =
        serde_json::from_str(&signals_json).map_err(|cause| EngineError::json(&job_id, cause))?;

    let payment = FailedPayment {
        id: row.get("payment_id")?,
        razorpay_payment_id: row.get("razorpay_payment_id")?,
        razorpay_order_id: row.get("razorpay_order_id")?,
        customer: CustomerRef {
            id: row.get("customer_id")?,
            name: row.get("customer_name")?,
            email: row.get("customer_email")?,
            phone_masked: row.get("phone_masked")?,
            lifetime_value_paise: row.get("lifetime_value_paise")?,
            successful_payments: row.get("successful_payments")?,
        },
        amount_paise: row.get("amount_paise")?,
        method: row.get("method")?,
        card_network: row.get("card_network")?,
        issuer: row.get("issuer")?,
        failure_reason: row.get("failure_reason")?,
        gateway_description: row.get("gateway_description")?,
        failed_at: row.get("failed_at")?,
        attempt_count: row.get("attempt_count")?,
        is_subscription: row.get("is_subscription")?,
    };

    Ok(RecoveryJob {
        payment,
        status: row.get("status")?,
        risk_tier: row.get("risk_tier")?,
        recovery_score: row.get("recovery_score")?,
        recommended_action: RecoveryAction {
            kind: row.get("action_kind")?,
            label: row.get("action_label")?,
            channel: row.get("action_channel")?,
            confidence: row.get("action_confidence")?,
            signals,
            delay_minutes: row.get("action_delay_minutes")?,
        },
        attempts: Vec::new(),
        next_action_at: row.get("next_action_at")?,
        recovered_amount_paise: row.get("recovered_amount_paise")?,
        sla_expires_at: row.get("sla_expires_at")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        assigned_to: row.get("assigned_to")?,
        id: job_id,
    })
}

/// Loads attempts for a whole page in one query. The obvious alternative — a
/// query per job — turns a 50-row queue into 51 round trips.
fn attach_attempts(connection: &Connection, jobs: &mut [RecoveryJob]) -> EngineResult<()> {
    if jobs.is_empty() {
        return Ok(());
    }

    let sql = format!(
        "SELECT job_id, id, sequence, kind, channel, occurred_at, outcome, note
           FROM recovery_attempts
          WHERE job_id IN ({})
          ORDER BY job_id, sequence",
        placeholders(jobs.len())
    );
    let ids: Vec<Value> = jobs
        .iter()
        .map(|job| Value::Text(job.id.clone()))
        .collect();

    let mut statement = connection.prepare(&sql)?;
    let mut rows = statement.query(params_from_iter(ids.iter()))?;

    let mut grouped: HashMap<String, Vec<RecoveryAttempt>> = HashMap::new();
    while let Some(row) = rows.next()? {
        let job_id: String = row.get("job_id")?;
        grouped.entry(job_id).or_default().push(RecoveryAttempt {
            id: row.get("id")?,
            sequence: row.get("sequence")?,
            kind: row.get("kind")?,
            channel: row.get("channel")?,
            occurred_at: row.get("occurred_at")?,
            outcome: row.get("outcome")?,
            note: row.get("note")?,
        });
    }

    for job in jobs.iter_mut() {
        if let Some(attempts) = grouped.remove(&job.id) {
            job.attempts = attempts;
        }
    }

    Ok(())
}

/// Kinds that reach the customer, used by the insight that counts them.
pub const fn touches_customer(kind: RecoveryActionKind) -> bool {
    !matches!(
        kind,
        RecoveryActionKind::AutoRetry
            | RecoveryActionKind::RetryOnPayday
            | RecoveryActionKind::RetryAfterDowntime
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Store;
    use crate::domain::{FailureReason, JobSort, PaymentMethod};

    fn payment(index: u32, reason: FailureReason, amount_paise: i64) -> FailedPayment {
        FailedPayment {
            id: format!("fp_{index:04}"),
            razorpay_payment_id: format!("pay_TEST{index:04}"),
            razorpay_order_id: format!("order_TEST{index:04}"),
            customer: CustomerRef {
                id: format!("cust_{index:04}"),
                name: format!("Customer {index}"),
                email: format!("customer{index}@example.in"),
                phone_masked: "+91 98••• ••21".into(),
                lifetime_value_paise: 24_00_000,
                successful_payments: 3,
            },
            amount_paise,
            method: PaymentMethod::Card,
            card_network: Some("VISA".into()),
            issuer: Some("HDFC Bank".into()),
            failure_reason: reason,
            gateway_description: "Payment failed".into(),
            failed_at: "2026-08-20T11:40:00.000Z".into(),
            attempt_count: 1,
            is_subscription: false,
        }
    }

    fn store_with_two_jobs() -> Store {
        let store = Store::in_memory().unwrap();
        {
            let mut connection = store.lock().unwrap();
            let transaction = connection.transaction().unwrap();
            ingest(
                &transaction,
                &payment(1, FailureReason::GatewayTimeout, 1_20_000),
                Actor::engine(),
            )
            .unwrap();
            ingest(
                &transaction,
                &payment(2, FailureReason::MandateRevoked, 90_00_000),
                Actor::engine(),
            )
            .unwrap();
            transaction.commit().unwrap();
        }
        store
    }

    fn page() -> PageRequest {
        PageRequest {
            offset: 0,
            limit: 25,
            sort: None,
        }
    }

    #[test]
    fn ingest_scores_the_payment_and_queues_a_job() {
        let store = store_with_two_jobs();
        let connection = store.lock().unwrap();

        let job = get(&connection, "job_0001").unwrap().unwrap();
        assert_eq!(job.status, RecoveryStatus::Queued);
        assert_eq!(job.payment.razorpay_payment_id, "pay_TEST0001");
        // A gateway timeout is a silent retry, and the evidence must survive
        // the round trip through SQLite.
        assert_eq!(job.recommended_action.kind, RecoveryActionKind::AutoRetry);
        assert!(!job.recommended_action.signals.is_empty());
        assert!(job.next_action_at.is_some());
        assert!(job.sla_expires_at > job.payment.failed_at);
    }

    #[test]
    fn ingest_is_idempotent_on_the_razorpay_payment_id() {
        let store = store_with_two_jobs();
        let mut connection = store.lock().unwrap();
        let transaction = connection.transaction().unwrap();

        // Razorpay redelivers `payment.failed`; a second job would chase the
        // same rupees twice.
        let repeat = ingest(
            &transaction,
            &payment(1, FailureReason::GatewayTimeout, 1_20_000),
            Actor::engine(),
        )
        .unwrap();
        assert_eq!(repeat, None);
        transaction.commit().unwrap();

        let all = list(&connection, &QueueFilters::default(), &page()).unwrap();
        assert_eq!(all.total, 2);
    }

    #[test]
    fn filters_and_search_narrow_the_total() {
        let store = store_with_two_jobs();
        let connection = store.lock().unwrap();

        let mut filters = QueueFilters::default();
        filters.reasons = vec![FailureReason::MandateRevoked];
        assert_eq!(list(&connection, &filters, &page()).unwrap().total, 1);

        let mut search = QueueFilters::default();
        search.search = "Customer 2".to_string();
        let found = list(&connection, &search, &page()).unwrap();
        assert_eq!(found.total, 1);
        assert_eq!(found.rows[0].id, "job_0002");

        let mut nobody = QueueFilters::default();
        nobody.search = "no such person".to_string();
        assert_eq!(list(&connection, &nobody, &page()).unwrap().total, 0);
    }

    #[test]
    fn sorting_by_amount_puts_the_biggest_exposure_first() {
        let store = store_with_two_jobs();
        let connection = store.lock().unwrap();

        let sorted = list(
            &connection,
            &QueueFilters::default(),
            &PageRequest {
                offset: 0,
                limit: 25,
                sort: Some(JobSort::AmountDesc),
            },
        )
        .unwrap();

        assert_eq!(sorted.rows[0].id, "job_0002");
    }

    #[test]
    fn approving_schedules_the_action_and_leaves_a_trail() {
        let store = store_with_two_jobs();
        let mut connection = store.lock().unwrap();

        let transaction = connection.transaction().unwrap();
        let job = approve(&transaction, "job_0001", "Desktop operator").unwrap();
        transaction.commit().unwrap();

        assert_eq!(job.status, RecoveryStatus::Scheduled);
        assert!(job.next_action_at.is_some());

        let trail = audit::for_job(&connection, "job_0001").unwrap();
        assert!(trail.iter().any(|event| event.action == "job.action.approved"));
    }

    #[test]
    fn suppressing_clears_the_pending_action() {
        let store = store_with_two_jobs();
        let mut connection = store.lock().unwrap();

        let transaction = connection.transaction().unwrap();
        let job = suppress(&transaction, "job_0002", "Customer disputed the charge", "Ops").unwrap();
        transaction.commit().unwrap();

        assert_eq!(job.status, RecoveryStatus::Suppressed);
        // The schema forbids a closed job with a live action; this is the code
        // path that has to respect it.
        assert_eq!(job.next_action_at, None);
        assert_eq!(job.assigned_to.as_deref(), Some("Ops"));
    }

    #[test]
    fn a_suppression_without_a_reason_is_refused() {
        let store = store_with_two_jobs();
        let mut connection = store.lock().unwrap();
        let transaction = connection.transaction().unwrap();

        let refused = suppress(&transaction, "job_0001", "   ", "Ops");
        assert!(refused.is_err());
    }

    #[test]
    fn a_closed_job_refuses_further_action() {
        let store = store_with_two_jobs();
        let mut connection = store.lock().unwrap();

        let transaction = connection.transaction().unwrap();
        suppress(&transaction, "job_0001", "Fraud review", "Ops").unwrap();
        transaction.commit().unwrap();

        let transaction = connection.transaction().unwrap();
        let message = approve(&transaction, "job_0001", "Ops").unwrap_err().to_string();
        assert!(message.contains("suppressed"), "{message}");
        assert!(retry_now(&transaction, "job_0001", "Ops").is_err());
    }

    #[test]
    fn retrying_now_records_a_pending_attempt() {
        let store = store_with_two_jobs();
        let mut connection = store.lock().unwrap();

        let transaction = connection.transaction().unwrap();
        let job = retry_now(&transaction, "job_0001", "Ops").unwrap();
        transaction.commit().unwrap();

        assert_eq!(job.status, RecoveryStatus::InProgress);
        assert_eq!(job.attempts.len(), 1);
        assert_eq!(job.attempts[0].sequence, 1);
        assert_eq!(job.attempts[0].id, "job_0001-a1");
        // Nothing was actually sent, so claiming success would be a lie.
        assert_eq!(
            job.attempts[0].outcome,
            crate::domain::AttemptOutcome::Pending
        );
    }

    #[test]
    fn a_missing_job_reads_as_none_and_refuses_transitions() {
        let store = store_with_two_jobs();
        let mut connection = store.lock().unwrap();

        assert!(get(&connection, "job_nope").unwrap().is_none());

        let transaction = connection.transaction().unwrap();
        assert!(approve(&transaction, "job_nope", "Ops").is_err());
    }

    #[test]
    fn the_sweep_only_sees_jobs_that_are_actually_due() {
        let store = store_with_two_jobs();
        let mut connection = store.lock().unwrap();

        // Both jobs failed in the past, so their actions are already due.
        let ready = due(&connection, &clock::now_iso(), 10).unwrap();
        assert_eq!(ready.len(), 2);

        let transaction = connection.transaction().unwrap();
        start_due_job(&transaction, &ready[0]).unwrap();
        transaction.commit().unwrap();

        // Once started, a job is no longer queued or scheduled.
        let still_due = due(&connection, &clock::now_iso(), 10).unwrap();
        assert_eq!(still_due.len(), 1);

        assert_eq!(
            count_by_status(&connection, RecoveryStatus::ACTIVE).unwrap(),
            2
        );
    }
}
