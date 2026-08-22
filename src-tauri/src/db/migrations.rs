//! Schema migrations.
//!
//! Forward-only and numbered. Each migration is a `.sql` file compiled into the
//! binary with `include_str!`, so a build either has its schema or does not
//! link — there is no way to ship an executable that looks for a migration file
//! at runtime and cannot find it.
//!
//! Applying a migration and recording that it was applied happen in the same
//! transaction. That is the only invariant that matters here: a half-applied
//! schema with a bookkeeping row claiming success is unrecoverable without
//! manual surgery, while a rolled-back attempt just runs again next launch.

use rusqlite::{params, Connection};

use crate::clock;
use crate::error::{EngineError, EngineResult};

pub struct Migration {
    pub version: i64,
    /// Shown in `schema_migrations` so a support dump reads as prose.
    pub name: &'static str,
    pub sql: &'static str,
}

/// Every migration, ascending. Append only — editing a shipped migration means
/// two installs disagree about what version 1 was.
pub const MIGRATIONS: &[Migration] = &[Migration {
    version: 1,
    name: "initial",
    sql: include_str!("schema/0001_initial.sql"),
}];

const BOOKKEEPING: &str = "CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;";

/// Brings `connection` up to the latest version, returning the versions that
/// this call actually applied. An already-current database returns an empty
/// vector and touches nothing.
pub fn apply(connection: &mut Connection) -> EngineResult<Vec<i64>> {
    connection.execute_batch(BOOKKEEPING).map_err(|cause| {
        EngineError::Store(format!("could not create the migration table: {cause}"))
    })?;

    let mut applied = Vec::new();

    for migration in MIGRATIONS {
        if is_applied(connection, migration.version)? {
            continue;
        }

        let transaction = connection.transaction().map_err(|cause| {
            EngineError::Store(format!(
                "could not begin migration {}: {cause}",
                migration.version
            ))
        })?;

        transaction.execute_batch(migration.sql).map_err(|cause| {
            EngineError::Store(format!(
                "migration {} ({}) failed: {cause}",
                migration.version, migration.name
            ))
        })?;

        transaction
            .execute(
                "INSERT INTO schema_migrations (version, name, applied_at)
                 VALUES (?1, ?2, ?3)",
                params![migration.version, migration.name, clock::now_iso()],
            )
            .map_err(|cause| {
                EngineError::Store(format!(
                    "could not record migration {}: {cause}",
                    migration.version
                ))
            })?;

        transaction.commit().map_err(|cause| {
            EngineError::Store(format!(
                "could not commit migration {}: {cause}",
                migration.version
            ))
        })?;

        applied.push(migration.version);
    }

    Ok(applied)
}

fn is_applied(connection: &Connection, version: i64) -> EngineResult<bool> {
    let count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM schema_migrations WHERE version = ?1",
            [version],
            |row| row.get(0),
        )
        .map_err(|cause| {
            EngineError::Store(format!("could not read the migration table: {cause}"))
        })?;

    Ok(count > 0)
}

/// The highest version recorded, or 0 for a database that has never been
/// migrated. Reported on the Audit Trail screen via engine status.
pub fn current_version(connection: &Connection) -> EngineResult<i64> {
    let version: Option<i64> = connection
        .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
            row.get(0)
        })
        .map_err(|cause| {
            EngineError::Store(format!("could not read the migration table: {cause}"))
        })?;

    Ok(version.unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn migrated() -> Connection {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch("PRAGMA foreign_keys = ON;")
            .unwrap();
        apply(&mut connection).unwrap();
        connection
    }

    #[test]
    fn versions_are_unique_and_ascending() {
        let mut previous = 0;
        for migration in MIGRATIONS {
            assert!(
                migration.version > previous,
                "migration {} is out of order",
                migration.version
            );
            previous = migration.version;
        }
    }

    #[test]
    fn migrations_are_not_empty_files() {
        for migration in MIGRATIONS {
            assert!(
                migration.sql.contains("CREATE"),
                "migration {} ({}) has no DDL — did include_str! pick up the wrong path?",
                migration.version,
                migration.name
            );
        }
    }

    #[test]
    fn a_fresh_database_applies_every_migration() {
        let mut connection = Connection::open_in_memory().unwrap();
        let applied = apply(&mut connection).unwrap();

        let expected: Vec<i64> = MIGRATIONS.iter().map(|entry| entry.version).collect();
        assert_eq!(applied, expected);
        assert_eq!(current_version(&connection).unwrap(), *expected.last().unwrap());
    }

    #[test]
    fn applying_twice_changes_nothing() {
        let mut connection = Connection::open_in_memory().unwrap();
        apply(&mut connection).unwrap();

        // The second pass must be a no-op rather than a re-run: the migration
        // SQL is not idempotent, so a re-run would fail on `CREATE TABLE`.
        let second = apply(&mut connection).unwrap();
        assert!(second.is_empty(), "migrations re-ran: {second:?}");
    }

    #[test]
    fn an_unmigrated_database_reports_version_zero() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(BOOKKEEPING).unwrap();
        assert_eq!(current_version(&connection).unwrap(), 0);
    }

    #[test]
    fn the_schema_rejects_an_unknown_enum_value() {
        let connection = migrated();

        connection
            .execute(
                "INSERT INTO customers (id, name, email, phone_masked)
                 VALUES ('cust_1', 'Aarav Sharma', 'aarav@example.in', '+91 ••••• 12')",
                [],
            )
            .unwrap();

        let typo = connection.execute(
            "INSERT INTO failed_payments (
               id, razorpay_payment_id, razorpay_order_id, customer_id, amount_paise,
               method, failure_reason, gateway_description, failed_at, attempt_count,
               is_subscription
             ) VALUES ('pay_row_1', 'pay_1', 'order_1', 'cust_1', 120000,
                       'creditcard', 'invalid_card', 'declined',
                       '2026-08-22T11:40:00.000Z', 1, 0)",
            [],
        );

        assert!(typo.is_err(), "'creditcard' is not a PaymentMethod variant");
    }

    #[test]
    fn recovered_money_requires_a_recovered_job() {
        let connection = migrated();
        seed_one_payment(&connection);

        // A queued job may not carry a recovered amount.
        let inconsistent = connection.execute(
            "INSERT INTO recovery_jobs (
               id, payment_id, status, risk_tier, recovery_score,
               action_kind, action_label, action_channel, action_confidence,
               action_delay_minutes, action_signals, next_action_at,
               recovered_amount_paise, sla_expires_at, created_at, updated_at
             ) VALUES ('job_1', 'pay_row_1', 'queued', 'high', 0.81,
                       'auto_retry', 'Retry now', 'gateway', 0.7, 45, '[]', NULL,
                       120000, '2026-08-25T11:40:00.000Z',
                       '2026-08-22T11:40:00.000Z', '2026-08-22T11:40:00.000Z')",
            [],
        );

        assert!(
            inconsistent.is_err(),
            "a queued job was allowed to claim recovered money"
        );
    }

    #[test]
    fn a_closed_job_cannot_keep_a_pending_action() {
        let connection = migrated();
        seed_one_payment(&connection);

        let stuck = connection.execute(
            "INSERT INTO recovery_jobs (
               id, payment_id, status, risk_tier, recovery_score,
               action_kind, action_label, action_channel, action_confidence,
               action_delay_minutes, action_signals, next_action_at,
               recovered_amount_paise, sla_expires_at, created_at, updated_at
             ) VALUES ('job_1', 'pay_row_1', 'suppressed', 'high', 0.81,
                       'auto_retry', 'Retry now', 'gateway', 0.7, 45, '[]',
                       '2026-08-22T12:40:00.000Z', NULL,
                       '2026-08-25T11:40:00.000Z',
                       '2026-08-22T11:40:00.000Z', '2026-08-22T11:40:00.000Z')",
            [],
        );

        assert!(
            stuck.is_err(),
            "a suppressed job kept a live next_action_at and the sweep would pick it up forever"
        );
    }

    #[test]
    fn the_audit_trail_cannot_be_rewritten() {
        let connection = migrated();

        connection
            .execute(
                "INSERT INTO audit_events (id, at, actor_type, actor_name, action, summary, severity)
                 VALUES ('evt_1', '2026-08-22T11:40:00.000Z', 'engine', 'Recovery engine',
                         'job.scored', 'Scored 1 failed payment', 'info')",
                [],
            )
            .unwrap();

        let edit = connection.execute(
            "UPDATE audit_events SET summary = 'Scored nothing' WHERE id = 'evt_1'",
            [],
        );
        assert!(edit.is_err(), "an audit event was edited");

        let delete = connection.execute("DELETE FROM audit_events WHERE id = 'evt_1'", []);
        assert!(delete.is_err(), "an audit event was deleted");

        // And the row is still there, unchanged.
        let summary: String = connection
            .query_row(
                "SELECT summary FROM audit_events WHERE id = 'evt_1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(summary, "Scored 1 failed payment");
    }

    fn seed_one_payment(connection: &Connection) {
        connection
            .execute(
                "INSERT INTO customers (id, name, email, phone_masked)
                 VALUES ('cust_1', 'Aarav Sharma', 'aarav@example.in', '+91 ••••• 12')",
                [],
            )
            .unwrap();

        connection
            .execute(
                "INSERT INTO failed_payments (
                   id, razorpay_payment_id, razorpay_order_id, customer_id, amount_paise,
                   method, failure_reason, gateway_description, failed_at, attempt_count,
                   is_subscription
                 ) VALUES ('pay_row_1', 'pay_1', 'order_1', 'cust_1', 120000,
                           'card', 'invalid_card', 'declined',
                           '2026-08-22T11:40:00.000Z', 1, 0)",
                [],
            )
            .unwrap();
    }
}
