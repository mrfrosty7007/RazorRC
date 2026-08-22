//! Playbooks: the merchant-editable rule sets the engine runs.
//!
//! Trigger and steps are stored as JSON documents. They are only ever read
//! whole, alongside the playbook, and their shape belongs to the domain model
//! rather than to the schema — normalising them into step tables would buy
//! joins nobody needs.

use rusqlite::{params, Connection, Row, Transaction};

use crate::clock;
use crate::db::audit;
use crate::domain::{
    Actor, AuditSeverity, Playbook, PlaybookStats, PlaybookStep, PlaybookTrigger,
};
use crate::error::{EngineError, EngineResult};

const SELECT: &str = "SELECT id, name, description, enabled, trigger_json, steps_json,
     stats_jobs_matched, stats_recovered_paise, stats_recovery_rate, updated_at
   FROM playbooks";

/// Ordered by `ordinal` so the list reads as a sequence of escalations rather
/// than in whatever order rows were written.
pub fn list(connection: &Connection) -> EngineResult<Vec<Playbook>> {
    let mut statement = connection.prepare(&format!("{SELECT} ORDER BY ordinal ASC"))?;
    let mut rows = statement.query([])?;

    let mut playbooks = Vec::new();
    while let Some(row) = rows.next()? {
        playbooks.push(read(row)?);
    }
    Ok(playbooks)
}

pub fn get(connection: &Connection, playbook_id: &str) -> EngineResult<Option<Playbook>> {
    let mut statement = connection.prepare(&format!("{SELECT} WHERE id = ?1"))?;
    let mut rows = statement.query(params![playbook_id])?;

    match rows.next()? {
        Some(row) => Ok(Some(read(row)?)),
        None => Ok(None),
    }
}

/// Turning a playbook on or off changes what the engine will do unattended, so
/// it is one of the events most worth having in the trail.
pub fn set_enabled(
    transaction: &Transaction<'_>,
    playbook_id: &str,
    enabled: bool,
    operator: &str,
) -> EngineResult<Playbook> {
    let playbook = get(transaction, playbook_id)?
        .ok_or_else(|| EngineError::UnknownPlaybook(playbook_id.to_string()))?;

    transaction.execute(
        "UPDATE playbooks SET enabled = ?2, updated_at = ?3 WHERE id = ?1",
        params![playbook_id, enabled, clock::now_iso()],
    )?;

    audit::record(
        transaction,
        &audit::event(
            Actor::operator(operator),
            if enabled {
                "playbook.enabled"
            } else {
                "playbook.disabled"
            },
            format!(
                "{} playbook “{}”",
                if enabled { "Enabled" } else { "Disabled" },
                playbook.name
            ),
            AuditSeverity::Notice,
            None,
            audit::meta([("playbook", playbook_id)]),
        ),
    )?;

    get(transaction, playbook_id)?
        .ok_or_else(|| EngineError::UnknownPlaybook(playbook_id.to_string()))
}

/// Inserts a playbook if it is not already present, leaving an existing one — and
/// whatever the merchant has since done to it — untouched.
pub fn ensure(
    connection: &Connection,
    ordinal: i64,
    playbook: &Playbook,
) -> EngineResult<()> {
    let trigger = serde_json::to_string(&playbook.trigger)
        .map_err(|cause| EngineError::json(&playbook.id, cause))?;
    let steps = serde_json::to_string(&playbook.steps)
        .map_err(|cause| EngineError::json(&playbook.id, cause))?;

    connection.execute(
        "INSERT OR IGNORE INTO playbooks
           (id, ordinal, name, description, enabled, trigger_json, steps_json,
            stats_jobs_matched, stats_recovered_paise, stats_recovery_rate, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, 0, 0, ?8)",
        params![
            playbook.id,
            ordinal,
            playbook.name,
            playbook.description,
            playbook.enabled,
            trigger,
            steps,
            clock::now_iso(),
        ],
    )?;

    Ok(())
}

/// Recomputes the roll-forward counters from the jobs each playbook's trigger
/// matches. Called after a sweep so the list is never stale by more than a tick.
pub fn refresh_stats(connection: &Connection) -> EngineResult<()> {
    for playbook in list(connection)? {
        let reasons: Vec<String> = playbook
            .trigger
            .reasons
            .iter()
            .map(|reason| reason.to_string())
            .collect();

        // A playbook with no reason filter matches on method alone; both empty
        // means it matches nothing, which is a configuration bug, not a query
        // that should quietly return the whole table.
        if reasons.is_empty() {
            continue;
        }

        let methods: Vec<String> = playbook
            .trigger
            .methods
            .iter()
            .map(|method| method.to_string())
            .collect();

        let sql = format!(
            "SELECT COUNT(*),
                    IFNULL(SUM(CASE WHEN j.status = 'recovered'
                                    THEN j.recovered_amount_paise ELSE 0 END), 0),
                    IFNULL(SUM(p.amount_paise), 0)
               FROM recovery_jobs j
               JOIN failed_payments p ON p.id = j.payment_id
              WHERE p.failure_reason IN ('{}')
                {}
                {}
                {}",
            reasons.join("', '"),
            if methods.is_empty() {
                String::new()
            } else {
                format!("AND p.method IN ('{}')", methods.join("', '"))
            },
            match playbook.trigger.min_amount_paise {
                Some(minimum) => format!("AND p.amount_paise >= {minimum}"),
                None => String::new(),
            },
            if playbook.trigger.subscription_only {
                "AND p.is_subscription = 1"
            } else {
                ""
            },
        );

        let (matched, recovered, exposed): (i64, i64, i64) =
            connection.query_row(&sql, [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?;

        let rate = if exposed > 0 {
            (recovered as f64 / exposed as f64).clamp(0.0, 1.0)
        } else {
            0.0
        };

        connection.execute(
            "UPDATE playbooks
                SET stats_jobs_matched = ?2, stats_recovered_paise = ?3,
                    stats_recovery_rate = ?4
              WHERE id = ?1",
            params![playbook.id, matched, recovered, rate],
        )?;
    }

    Ok(())
}

fn read(row: &Row<'_>) -> EngineResult<Playbook> {
    let id: String = row.get("id")?;
    let trigger_json: String = row.get("trigger_json")?;
    let steps_json: String = row.get("steps_json")?;

    let trigger: PlaybookTrigger =
        serde_json::from_str(&trigger_json).map_err(|cause| EngineError::json(&id, cause))?;
    let steps: Vec<PlaybookStep> =
        serde_json::from_str(&steps_json).map_err(|cause| EngineError::json(&id, cause))?;

    Ok(Playbook {
        name: row.get("name")?,
        description: row.get("description")?,
        enabled: row.get("enabled")?,
        trigger,
        steps,
        stats: PlaybookStats {
            jobs_matched: row.get("stats_jobs_matched")?,
            recovered_paise: row.get("stats_recovered_paise")?,
            recovery_rate: row.get("stats_recovery_rate")?,
        },
        updated_at: row.get("updated_at")?,
        id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Store;
    use crate::domain::{FailureReason, PaymentMethod, RecoveryActionKind};

    fn playbook(id: &str, enabled: bool) -> Playbook {
        Playbook {
            id: id.to_string(),
            name: "Salary-cycle retries".into(),
            description: "Re-present insufficient-funds failures into the payday window.".into(),
            enabled,
            trigger: PlaybookTrigger {
                reasons: vec![FailureReason::InsufficientFunds],
                methods: vec![PaymentMethod::Card, PaymentMethod::Emandate],
                min_amount_paise: None,
                subscription_only: false,
            },
            steps: vec![PlaybookStep {
                sequence: 1,
                kind: RecoveryActionKind::RetryOnPayday,
                delay_minutes: 0,
                stop_on_success: true,
            }],
            stats: PlaybookStats {
                jobs_matched: 0,
                recovered_paise: 0,
                recovery_rate: 0.0,
            },
            updated_at: clock::now_iso(),
        }
    }

    #[test]
    fn playbooks_round_trip_through_json_columns() {
        let store = Store::in_memory().unwrap();
        let connection = store.lock().unwrap();

        ensure(&connection, 1, &playbook("pb_payday", true)).unwrap();

        let stored = list(&connection).unwrap();
        assert_eq!(stored.len(), 1);
        assert!(stored[0].enabled);
        assert_eq!(stored[0].trigger.methods.len(), 2);
        assert_eq!(stored[0].steps[0].kind, RecoveryActionKind::RetryOnPayday);
        assert!(stored[0].steps[0].stop_on_success);
    }

    #[test]
    fn ensure_does_not_overwrite_a_merchants_changes() {
        let store = Store::in_memory().unwrap();
        let mut connection = store.lock().unwrap();

        ensure(&connection, 1, &playbook("pb_payday", true)).unwrap();

        let transaction = connection.transaction().unwrap();
        set_enabled(&transaction, "pb_payday", false, "Ops").unwrap();
        transaction.commit().unwrap();

        // A second startup must not turn it back on.
        ensure(&connection, 1, &playbook("pb_payday", true)).unwrap();
        assert!(!list(&connection).unwrap()[0].enabled);
    }

    #[test]
    fn toggling_writes_an_audit_event() {
        let store = Store::in_memory().unwrap();
        let mut connection = store.lock().unwrap();
        ensure(&connection, 1, &playbook("pb_payday", true)).unwrap();

        let transaction = connection.transaction().unwrap();
        let updated = set_enabled(&transaction, "pb_payday", false, "Aarav").unwrap();
        transaction.commit().unwrap();

        assert!(!updated.enabled);

        let query = crate::domain::AuditQuery {
            offset: 0,
            limit: 10,
            severities: Vec::new(),
            search: "playbook".into(),
            job_id: None,
        };
        let trail = audit::list(&connection, &query).unwrap();
        assert_eq!(trail.total, 1);
        assert_eq!(trail.rows[0].action, "playbook.disabled");
    }

    #[test]
    fn an_unknown_playbook_is_refused() {
        let store = Store::in_memory().unwrap();
        let mut connection = store.lock().unwrap();
        let transaction = connection.transaction().unwrap();

        let message = set_enabled(&transaction, "pb_nope", true, "Ops")
            .unwrap_err()
            .to_string();
        assert!(message.contains("pb_nope"), "{message}");
    }

    #[test]
    fn stats_refresh_from_the_jobs_that_match() {
        let store = Store::in_memory().unwrap();
        let connection = store.lock().unwrap();

        ensure(&connection, 1, &playbook("pb_payday", true)).unwrap();
        // No jobs yet, so the counters stay honest zeroes.
        refresh_stats(&connection).unwrap();

        let stored = list(&connection).unwrap();
        assert_eq!(stored[0].stats.jobs_matched, 0);
        assert_eq!(stored[0].stats.recovery_rate, 0.0);
    }
}
