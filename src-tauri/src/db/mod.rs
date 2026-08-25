//! The recovery store.
//!
//! SQLite, opened once at startup and shared behind a `Mutex`. A desktop app has
//! exactly one writer and a handful of short reads per screen, so a connection
//! pool would be ceremony; what matters instead is that every read and write
//! goes through this module, because that is what makes the audit trail
//! complete rather than best-effort.

pub mod audit;
pub mod chat;
pub mod jobs;
pub mod metrics;
pub mod migrations;
pub mod playbooks;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

use rusqlite::Connection;

use crate::clock;
use crate::error::{EngineError, EngineResult};

/// Set `REVIVEAI_DB_PATH` to point the store somewhere other than the app data
/// directory. Used by tests and by anyone who wants a throwaway database.
pub const DB_PATH_ENV: &str = "REVIVEAI_DB_PATH";

const DB_FILE_NAME: &str = "recovery.sqlite3";

pub struct Store {
    connection: Mutex<Connection>,
    path: PathBuf,
}

impl Store {
    /// Opens (creating if needed) the database in `directory` and migrates it.
    pub fn open_in(directory: &Path) -> EngineResult<Store> {
        std::fs::create_dir_all(directory).map_err(|cause| {
            EngineError::Store(format!("could not create {}: {cause}", directory.display()))
        })?;

        Store::open_at(&directory.join(DB_FILE_NAME))
    }

    pub fn open_at(path: &Path) -> EngineResult<Store> {
        let mut connection = Connection::open(path).map_err(|cause| {
            EngineError::Store(format!("could not open {}: {cause}", path.display()))
        })?;

        configure(&connection)?;
        migrations::apply(&mut connection)?;

        Ok(Store {
            connection: Mutex::new(connection),
            path: path.to_path_buf(),
        })
    }

    /// An empty, migrated, in-process database. Used by the tests in this crate.
    pub fn in_memory() -> EngineResult<Store> {
        let mut connection = Connection::open_in_memory()
            .map_err(|cause| EngineError::Store(format!("could not open memory store: {cause}")))?;

        configure(&connection)?;
        migrations::apply(&mut connection)?;

        Ok(Store {
            connection: Mutex::new(connection),
            path: PathBuf::from(":memory:"),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// A poisoned lock means an earlier panic left the store mid-write. Rather
    /// than recovering the guard and writing on top of unknown state, this
    /// surfaces as an error the UI shows and a restart clears.
    pub fn lock(&self) -> EngineResult<MutexGuard<'_, Connection>> {
        self.connection.lock().map_err(|_| EngineError::LockPoisoned)
    }
}

fn configure(connection: &Connection) -> EngineResult<()> {
    // WAL lets the sweep thread read while a command writes. Note that setting
    // `journal_mode` *returns a row* (the mode actually in force), so it has to
    // be run as a query rather than an execute. An in-memory database answers
    // `memory` here, which is expected.
    connection
        .query_row("PRAGMA journal_mode = WAL", [], |_row| Ok(()))
        .map_err(|cause| EngineError::Store(format!("could not set the journal mode: {cause}")))?;

    connection
        .execute_batch(
            // Referential integrity is off by default in SQLite, which surprises
            // people. With WAL, `synchronous = NORMAL` risks at most the last
            // transaction on an OS crash and is far faster than FULL — an
            // acceptable trade when the lost work is a sweep that recomputes.
            "PRAGMA foreign_keys = ON;
             PRAGMA synchronous = NORMAL;",
        )
        .map_err(|cause| EngineError::Store(format!("could not configure the store: {cause}")))?;

    connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|cause| EngineError::Store(format!("could not set busy timeout: {cause}")))?;

    Ok(())
}

/// `?, ?, ?` for an `IN` list of `count` values.
///
/// Enumerated filter values arrive from the UI as parsed enums, but they are
/// still bound as parameters rather than interpolated. Building SQL by
/// concatenating values is how a filter box becomes an injection point.
pub fn placeholders(count: usize) -> String {
    let mut out = String::with_capacity(count * 3);
    for index in 0..count {
        if index > 0 {
            out.push_str(", ");
        }
        out.push('?');
    }
    out
}

/// Wraps a search term for `LIKE`, escaping the wildcards a user may type.
///
/// Without this, searching for `50%` matches everything and searching for `_`
/// matches every single character, which reads as a broken search box.
pub fn like_pattern(term: &str) -> String {
    let mut escaped = String::with_capacity(term.len() + 2);
    for character in term.chars() {
        if matches!(character, '%' | '_' | '\\') {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    format!("%{escaped}%")
}

/// Unique id for an audit event.
///
/// Timestamp plus a process-local counter: sortable, collision-free within a
/// run, and readable in a bug report. A UUID would be opaque and would pull in
/// a dependency for no benefit here.
pub fn next_event_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let sequence = COUNTER.fetch_add(1, Ordering::Relaxed);

    let stamp: String = clock::now_iso()
        .chars()
        .filter(|character| character.is_ascii_digit())
        .collect();

    format!("evt_{stamp}_{sequence:06}")
}

/// Attempt ids follow the job they belong to, so a trail row can be traced back
/// to a job by eye.
pub fn attempt_id(job_id: &str, sequence: i64) -> String {
    format!("{job_id}-a{sequence}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_store_is_migrated_and_empty() {
        let store = Store::in_memory().unwrap();
        let connection = store.lock().unwrap();

        let jobs: i64 = connection
            .query_row("SELECT COUNT(*) FROM recovery_jobs", [], |row| row.get(0))
            .unwrap();
        assert_eq!(jobs, 0);

        let applied: i64 = connection
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(applied, migrations::MIGRATIONS.len() as i64);
    }

    #[test]
    fn foreign_keys_are_enforced() {
        let store = Store::in_memory().unwrap();
        let connection = store.lock().unwrap();

        let orphan = connection.execute(
            "INSERT INTO failed_payments (
               id, razorpay_payment_id, razorpay_order_id, customer_id, amount_paise,
               method, failure_reason, gateway_description, failed_at, attempt_count,
               is_subscription
             ) VALUES ('p1', 'pay_1', 'order_1', 'nobody', 100, 'card',
                       'invalid_card', 'declined', '2026-08-22T00:00:00.000Z', 1, 0)",
            [],
        );

        assert!(orphan.is_err(), "a payment with no customer was accepted");
    }

    #[test]
    fn placeholders_match_the_value_count() {
        assert_eq!(placeholders(1), "?");
        assert_eq!(placeholders(3), "?, ?, ?");
        assert_eq!(placeholders(0), "");
    }

    #[test]
    fn like_wildcards_in_a_search_term_are_escaped() {
        assert_eq!(like_pattern("aarav"), "%aarav%");
        assert_eq!(like_pattern("50%"), "%50\\%%");
        assert_eq!(like_pattern("a_b"), "%a\\_b%");
        assert_eq!(like_pattern("back\\slash"), "%back\\\\slash%");
    }

    #[test]
    fn event_ids_are_unique_and_sortable() {
        let first = next_event_id();
        let second = next_event_id();
        assert_ne!(first, second);
        assert!(first < second, "{first} should sort before {second}");
        assert!(first.starts_with("evt_"));
    }

    #[test]
    fn attempt_ids_carry_their_job() {
        assert_eq!(attempt_id("job_0042", 3), "job_0042-a3");
    }
}
