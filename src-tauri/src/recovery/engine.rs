//! The background sweep.
//!
//! One thread, one job: find recovery jobs whose scheduled moment has arrived
//! and move them along. It is deliberately the dullest module in the crate —
//! everything it might have decided has already been decided by
//! [`crate::recovery::rules`] at ingest time, and written down.
//!
//! Two properties are worth stating because they are easy to lose:
//!
//! * **A sweep that finds nothing writes nothing.** Running every minute, a
//!   chatty sweep would bury the merchant's own actions in the audit trail
//!   within a day.
//! * **One job's failure does not abort the batch.** Each transition commits on
//!   its own transaction, so a job that has been closed by an operator between
//!   the query and the write is skipped rather than stalling every job behind
//!   it.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use crate::clock;
use crate::db::{audit, jobs, metrics, playbooks, Store};
use crate::domain::{Actor, AuditSeverity, EngineSource, EngineStatus};
use crate::error::EngineResult;

/// How often the sweep looks for due work. Recovery deadlines are measured in
/// hours, so a minute of latency is free, and a slow tick keeps the desktop app
/// off the CPU.
const SWEEP_INTERVAL: Duration = Duration::from_secs(60);

/// The thread wakes on this cadence to check the stop flag, so quitting the app
/// does not wait out a whole sweep interval.
const TICK: Duration = Duration::from_millis(250);

/// Ceiling on one batch. Bounded so a backlog is worked off across several
/// sweeps instead of holding the write lock for an unpredictable stretch.
const BATCH: i64 = 25;

/// Shared, observable state for the sweep thread.
///
/// The sidebar polls this through `get_engine_status`, which is the only reason
/// it exists: an engine that cannot be seen to be running is indistinguishable
/// from a mock.
#[derive(Debug, Default)]
pub struct EngineHandle {
    running: AtomicBool,
    stopping: AtomicBool,
    last_sweep_at: Mutex<Option<String>>,
}

impl EngineHandle {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::Relaxed)
    }

    pub fn is_stopping(&self) -> bool {
        self.stopping.load(Ordering::Relaxed)
    }

    /// Asks the thread to finish its tick and exit. Idempotent.
    pub fn request_stop(&self) {
        self.stopping.store(true, Ordering::Relaxed);
    }

    /// The last time a sweep completed, or `None` if none has yet.
    ///
    /// A poisoned lock reads as "unknown" rather than propagating: the status
    /// call exists to report health, and it would be perverse for it to fail.
    pub fn last_sweep_at(&self) -> Option<String> {
        self.last_sweep_at
            .lock()
            .ok()
            .and_then(|stamp| stamp.clone())
    }

    fn set_running(&self, running: bool) {
        self.running.store(running, Ordering::Relaxed);
    }

    fn record_sweep(&self, at: String) {
        if let Ok(mut stamp) = self.last_sweep_at.lock() {
            *stamp = Some(at);
        }
    }
}

/// Runs one pass and returns how many jobs it started.
///
/// The cutoff is captured once, before the query, so a job scheduled during the
/// sweep waits for the next one instead of being picked up half-way through.
pub fn sweep(store: &Store, handle: &EngineHandle) -> EngineResult<usize> {
    let cutoff = clock::now_iso();
    let mut connection = store.lock()?;

    let due = jobs::due(&connection, &cutoff, BATCH)?;
    let mut started = 0usize;
    let mut skipped = 0usize;

    for job_id in &due {
        let transaction = connection.transaction()?;
        match jobs::start_due_job(&transaction, job_id) {
            Ok(()) => {
                transaction.commit()?;
                started += 1;
            }
            Err(_) => {
                // Almost always a job an operator closed since the query above.
                // Rolling back and moving on is the correct reading of that
                // race: the human's decision wins.
                drop(transaction);
                skipped += 1;
            }
        }
    }

    if started > 0 {
        playbooks::refresh_stats(&connection)?;

        audit::log(
            &connection,
            Actor::scheduler(),
            "engine.sweep",
            format!(
                "Started {started} scheduled {}",
                if started == 1 { "action" } else { "actions" }
            ),
            AuditSeverity::Info,
            None,
            audit::meta([
                ("started", started.to_string()),
                ("skipped", skipped.to_string()),
                ("due", due.len().to_string()),
            ]),
        )?;
    }

    handle.record_sweep(cutoff);
    Ok(started)
}

/// Health for the sidebar.
///
/// `razorpay_connected` reports whether credentials are *present*, not whether
/// they have been accepted — Phase 1 sends no requests, and claiming a verified
/// connection on the strength of a non-empty environment variable would be a
/// lie the UI then repeats.
pub fn status(store: &Store, handle: &EngineHandle) -> EngineResult<EngineStatus> {
    let queue_depth = {
        let connection = store.lock()?;
        metrics::queue_depth(&connection)?
    };

    Ok(EngineStatus {
        running: handle.is_running(),
        source: EngineSource::RustEngine,
        queue_depth,
        last_sweep_at: handle.last_sweep_at(),
        razorpay_connected: credentials_present(),
    })
}

fn credentials_present() -> bool {
    ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET"]
        .iter()
        .all(|key| {
            std::env::var(key)
                .map(|value| !value.trim().is_empty())
                .unwrap_or(false)
        })
}

/// Starts the sweep thread.
///
/// Failures are reported to stderr and the loop continues. The alternative —
/// letting the thread die on a transient lock contention — would leave the UI
/// reporting a healthy engine that has silently stopped working.
pub fn spawn(store: Arc<Store>, handle: Arc<EngineHandle>) -> JoinHandle<()> {
    thread::spawn(move || {
        handle.set_running(true);

        while !handle.is_stopping() {
            if let Err(error) = sweep(&store, &handle) {
                eprintln!("[razor-rc] sweep failed: {error}");
            }

            let mut waited = Duration::ZERO;
            while waited < SWEEP_INTERVAL && !handle.is_stopping() {
                thread::sleep(TICK);
                waited += TICK;
            }
        }

        handle.set_running(false);
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{CustomerRef, FailedPayment, FailureReason, PaymentMethod};
    use rusqlite::Connection;

    fn payment(index: u32) -> FailedPayment {
        FailedPayment {
            id: format!("fp_{index:04}"),
            razorpay_payment_id: format!("pay_TEST{index:04}"),
            razorpay_order_id: format!("order_TEST{index:04}"),
            customer: CustomerRef {
                id: format!("cust_{index:04}"),
                name: format!("Customer {index}"),
                email: format!("customer{index}@example.in"),
                phone_masked: "+91 98••• ••21".into(),
                lifetime_value_paise: 8_00_000,
                successful_payments: 3,
            },
            amount_paise: 2_00_000,
            method: PaymentMethod::Card,
            card_network: Some("VISA".into()),
            issuer: Some("HDFC Bank".into()),
            failure_reason: FailureReason::GatewayTimeout,
            gateway_description: "Gateway timed out".into(),
            failed_at: clock::iso_days_ago(0.5),
            attempt_count: 1,
            is_subscription: false,
        }
    }

    /// Two jobs, one due an hour ago and one due tomorrow.
    fn store_with_one_due_job() -> Store {
        let store = Store::in_memory().unwrap();
        {
            let mut connection = store.lock().unwrap();
            let transaction = connection.transaction().unwrap();
            jobs::ingest(&transaction, &payment(1), Actor::engine()).unwrap();
            jobs::ingest(&transaction, &payment(2), Actor::engine()).unwrap();

            transaction
                .execute(
                    "UPDATE recovery_jobs SET next_action_at = ?2 WHERE id = ?1",
                    rusqlite::params!["job_0001", clock::iso_minutes_from_now(-60)],
                )
                .unwrap();
            transaction
                .execute(
                    "UPDATE recovery_jobs SET next_action_at = ?2 WHERE id = ?1",
                    rusqlite::params!["job_0002", clock::iso_minutes_from_now(24 * 60)],
                )
                .unwrap();

            transaction.commit().unwrap();
        }
        store
    }

    fn sweep_events(connection: &Connection) -> i64 {
        connection
            .query_row(
                "SELECT COUNT(*) FROM audit_events WHERE action = 'engine.sweep'",
                [],
                |row| row.get(0),
            )
            .unwrap()
    }

    fn status_of(connection: &Connection, job_id: &str) -> String {
        connection
            .query_row(
                "SELECT status FROM recovery_jobs WHERE id = ?1",
                rusqlite::params![job_id],
                |row| row.get(0),
            )
            .unwrap()
    }

    #[test]
    fn a_sweep_of_an_empty_store_starts_nothing() {
        let store = Store::in_memory().unwrap();
        let handle = EngineHandle::new();

        assert_eq!(sweep(&store, &handle).unwrap(), 0);
    }

    #[test]
    fn only_jobs_whose_moment_has_arrived_are_started() {
        let store = store_with_one_due_job();
        let handle = EngineHandle::new();

        assert_eq!(sweep(&store, &handle).unwrap(), 1);

        let connection = store.lock().unwrap();
        assert_eq!(status_of(&connection, "job_0001"), "in_progress");
        assert_eq!(status_of(&connection, "job_0002"), "queued");
    }

    #[test]
    fn a_job_is_not_started_twice() {
        let store = store_with_one_due_job();
        let handle = EngineHandle::new();

        assert_eq!(sweep(&store, &handle).unwrap(), 1);
        // Nothing new is due, and the job now in flight must not be re-started.
        assert_eq!(sweep(&store, &handle).unwrap(), 0);

        let connection = store.lock().unwrap();
        let attempts: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM recovery_attempts WHERE job_id = 'job_0001'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(attempts, 1, "the sweep created a duplicate attempt");
    }

    #[test]
    fn an_idle_sweep_leaves_the_audit_trail_alone() {
        let store = store_with_one_due_job();
        let handle = EngineHandle::new();

        sweep(&store, &handle).unwrap();
        let after_work = {
            let connection = store.lock().unwrap();
            sweep_events(&connection)
        };
        assert_eq!(after_work, 1, "a sweep that did work wrote no event");

        // Sixty of these run every hour; none of them may add a row.
        for _ in 0..3 {
            sweep(&store, &handle).unwrap();
        }

        let connection = store.lock().unwrap();
        assert_eq!(
            sweep_events(&connection),
            1,
            "idle sweeps are spamming the trail"
        );
    }

    #[test]
    fn the_handle_reports_when_it_last_swept() {
        let store = Store::in_memory().unwrap();
        let handle = EngineHandle::new();

        assert!(handle.last_sweep_at().is_none());
        sweep(&store, &handle).unwrap();
        assert!(handle.last_sweep_at().is_some());
    }

    #[test]
    fn status_reports_the_open_queue_depth() {
        let store = store_with_one_due_job();
        let handle = EngineHandle::new();

        let reported = status(&store, &handle).unwrap();
        assert_eq!(reported.queue_depth, 2);
        assert_eq!(reported.source, EngineSource::RustEngine);
        // Nothing has been spawned, so claiming to be running would be false.
        assert!(!reported.running);
    }

    #[test]
    fn a_stop_request_is_visible_immediately() {
        let handle = EngineHandle::new();
        assert!(!handle.is_stopping());
        handle.request_stop();
        handle.request_stop();
        assert!(handle.is_stopping());
    }
}
