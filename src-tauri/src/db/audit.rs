//! The audit trail.
//!
//! Every state change in ReviveAI is written here, in the same transaction as
//! the change itself. That coupling is the point: a trail written afterwards, on
//! a best-effort basis, is a trail that disagrees with the ledger the first time
//! a write fails halfway.
//!
//! The table refuses UPDATE and DELETE at the database level (see the triggers
//! in `schema/0001_initial.sql`), so this module only ever inserts and reads.

use std::collections::BTreeMap;

use rusqlite::{params, params_from_iter, types::Value, Connection, Row};

use crate::clock;
use crate::db::{self, like_pattern, placeholders};
use crate::domain::{Actor, AuditEvent, AuditQuery, AuditSeverity, Paged};
use crate::error::{EngineError, EngineResult};

const COLUMNS: &str = "id, at, actor_type, actor_name, action, summary, severity, job_id, metadata_json";

/// Builds an event, stamping it with an id and the current time.
///
/// `action` is the dotted machine name (`job.retry.scheduled`); `summary` is the
/// sentence a merchant reads. Both are stored because the first is greppable and
/// the second is understandable, and collapsing them loses one or the other.
pub fn event(
    actor: Actor,
    action: impl Into<String>,
    summary: impl Into<String>,
    severity: AuditSeverity,
    job_id: Option<String>,
    metadata: BTreeMap<String, String>,
) -> AuditEvent {
    AuditEvent {
        id: db::next_event_id(),
        at: clock::now_iso(),
        actor,
        action: action.into(),
        summary: summary.into(),
        severity,
        job_id,
        metadata,
    }
}

/// Convenience for the `[("key", value)]` literals the callers use.
pub fn meta<K, V>(pairs: impl IntoIterator<Item = (K, V)>) -> BTreeMap<String, String>
where
    K: Into<String>,
    V: Into<String>,
{
    pairs
        .into_iter()
        .map(|(key, value)| (key.into(), value.into()))
        .collect()
}

/// Appends `event`. Takes a bare `&Connection` so it can be handed a
/// `&Transaction` (which derefs to one) and enrolled in the caller's write.
pub fn record(connection: &Connection, event: &AuditEvent) -> EngineResult<()> {
    let metadata = serde_json::to_string(&event.metadata)
        .map_err(|cause| EngineError::json(&event.id, cause))?;

    connection.execute(
        "INSERT INTO audit_events
           (id, at, actor_type, actor_name, action, summary, severity, job_id, metadata_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            event.id,
            event.at,
            event.actor.kind,
            event.actor.name,
            event.action,
            event.summary,
            event.severity,
            event.job_id,
            metadata,
        ],
    )?;

    Ok(())
}

/// Builds and appends in one step, returning what was written so a command can
/// echo it back to the UI.
pub fn log(
    connection: &Connection,
    actor: Actor,
    action: impl Into<String>,
    summary: impl Into<String>,
    severity: AuditSeverity,
    job_id: Option<String>,
    metadata: BTreeMap<String, String>,
) -> EngineResult<AuditEvent> {
    let entry = event(actor, action, summary, severity, job_id, metadata);
    record(connection, &entry)?;
    Ok(entry)
}

/// A page of the trail, newest first, with the unfiltered-by-paging total.
pub fn list(connection: &Connection, query: &AuditQuery) -> EngineResult<Paged<AuditEvent>> {
    let (filter, mut values) = filter_clause(query);

    let total: i64 = connection.query_row(
        &format!("SELECT COUNT(*) FROM audit_events {filter}"),
        params_from_iter(values.iter()),
        |row| row.get(0),
    )?;

    if total == 0 {
        return Ok(Paged::empty());
    }

    // `id` breaks ties: two events written in the same millisecond still page
    // deterministically, which is what stops a row appearing on two pages.
    let sql = format!(
        "SELECT {COLUMNS} FROM audit_events {filter}
         ORDER BY at DESC, id DESC
         LIMIT ? OFFSET ?"
    );

    values.push(Value::Integer(query.limit()));
    values.push(Value::Integer(query.offset()));

    let mut statement = connection.prepare(&sql)?;
    let mut rows = statement.query(params_from_iter(values.iter()))?;

    let mut events = Vec::new();
    while let Some(row) = rows.next()? {
        events.push(read_event(row)?);
    }

    Ok(Paged::new(events, total))
}

/// Every event for one job, oldest first — the job drawer's timeline.
pub fn for_job(connection: &Connection, job_id: &str) -> EngineResult<Vec<AuditEvent>> {
    let mut statement = connection.prepare(&format!(
        "SELECT {COLUMNS} FROM audit_events WHERE job_id = ?1 ORDER BY at ASC, id ASC"
    ))?;

    let mut rows = statement.query(params![job_id])?;

    let mut events = Vec::new();
    while let Some(row) = rows.next()? {
        events.push(read_event(row)?);
    }

    Ok(events)
}

fn filter_clause(query: &AuditQuery) -> (String, Vec<Value>) {
    let mut clauses: Vec<String> = Vec::new();
    let mut values: Vec<Value> = Vec::new();

    if !query.severities.is_empty() {
        clauses.push(format!(
            "severity IN ({})",
            placeholders(query.severities.len())
        ));
        for severity in &query.severities {
            values.push(Value::Text(severity.as_str().to_string()));
        }
    }

    if let Some(job_id) = &query.job_id {
        if !job_id.is_empty() {
            clauses.push("job_id = ?".to_string());
            values.push(Value::Text(job_id.clone()));
        }
    }

    let search = query.search.trim();
    if !search.is_empty() {
        // Deliberately not searching `metadata_json`: matching raw JSON would
        // hit key names and produce results a merchant cannot explain.
        clauses.push(
            "(summary LIKE ? ESCAPE '\\'
              OR action LIKE ? ESCAPE '\\'
              OR actor_name LIKE ? ESCAPE '\\'
              OR IFNULL(job_id, '') LIKE ? ESCAPE '\\')"
                .to_string(),
        );
        let pattern = like_pattern(search);
        for _ in 0..4 {
            values.push(Value::Text(pattern.clone()));
        }
    }

    if clauses.is_empty() {
        (String::new(), values)
    } else {
        (format!("WHERE {}", clauses.join(" AND ")), values)
    }
}

fn read_event(row: &Row<'_>) -> EngineResult<AuditEvent> {
    let id: String = row.get("id")?;
    let metadata_json: String = row.get("metadata_json")?;

    let metadata: BTreeMap<String, String> =
        serde_json::from_str(&metadata_json).map_err(|cause| EngineError::json(&id, cause))?;

    Ok(AuditEvent {
        at: row.get("at")?,
        actor: Actor {
            kind: row.get("actor_type")?,
            name: row.get("actor_name")?,
        },
        action: row.get("action")?,
        summary: row.get("summary")?,
        severity: row.get("severity")?,
        job_id: row.get("job_id")?,
        metadata,
        id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Store;

    fn query() -> AuditQuery {
        AuditQuery {
            offset: 0,
            limit: 50,
            severities: Vec::new(),
            search: String::new(),
            job_id: None,
        }
    }

    fn store_with_three_events() -> Store {
        let store = Store::in_memory().unwrap();
        {
            let connection = store.lock().unwrap();

            record(
                &connection,
                &AuditEvent {
                    id: "evt_1".into(),
                    at: "2026-08-22T09:00:00.000Z".into(),
                    actor: Actor::engine(),
                    action: "job.scored".into(),
                    summary: "Scored 12 failed payments".into(),
                    severity: AuditSeverity::Info,
                    job_id: Some("job_0001".into()),
                    metadata: meta([("jobs", "12")]),
                },
            )
            .unwrap();

            record(
                &connection,
                &AuditEvent {
                    id: "evt_2".into(),
                    at: "2026-08-22T10:00:00.000Z".into(),
                    actor: Actor::operator("Aarav Sharma"),
                    action: "job.retry.approved".into(),
                    summary: "Approved a UPI switch for job_0002".into(),
                    severity: AuditSeverity::Notice,
                    job_id: Some("job_0002".into()),
                    metadata: BTreeMap::new(),
                },
            )
            .unwrap();

            record(
                &connection,
                &AuditEvent {
                    id: "evt_3".into(),
                    at: "2026-08-22T11:00:00.000Z".into(),
                    actor: Actor::scheduler(),
                    action: "engine.sweep.completed".into(),
                    summary: "Queue sweep processed 3 due jobs".into(),
                    severity: AuditSeverity::Warning,
                    job_id: None,
                    metadata: meta([("due", "3")]),
                },
            )
            .unwrap();
        }
        store
    }

    #[test]
    fn events_round_trip_through_storage() {
        let store = store_with_three_events();
        let connection = store.lock().unwrap();

        let page = list(&connection, &query()).unwrap();
        assert_eq!(page.total, 3);

        // Newest first, so the sweep leads.
        let newest = &page.rows[0];
        assert_eq!(newest.id, "evt_3");
        assert_eq!(newest.actor.name, "scheduler");
        assert_eq!(newest.severity, AuditSeverity::Warning);
        assert_eq!(newest.job_id, None);
        assert_eq!(newest.metadata.get("due").map(String::as_str), Some("3"));
    }

    #[test]
    fn an_empty_trail_reports_zero_rather_than_erroring() {
        let store = Store::in_memory().unwrap();
        let connection = store.lock().unwrap();

        let page = list(&connection, &query()).unwrap();
        assert_eq!(page.total, 0);
        assert!(page.rows.is_empty());
    }

    #[test]
    fn severity_filters_narrow_the_total_too() {
        let store = store_with_three_events();
        let connection = store.lock().unwrap();

        let mut filtered = query();
        filtered.severities = vec![AuditSeverity::Notice, AuditSeverity::Warning];

        let page = list(&connection, &filtered).unwrap();
        // A footer reading "1–2 of 3" while showing two rows is the bug this guards.
        assert_eq!(page.total, 2);
        assert_eq!(page.rows.len(), 2);
    }

    #[test]
    fn search_covers_summary_action_and_actor() {
        let store = store_with_three_events();
        let connection = store.lock().unwrap();

        for (term, expected) in [("sweep", 1), ("Aarav", 1), ("job.", 2), ("job_0002", 1)] {
            let mut filtered = query();
            filtered.search = term.to_string();
            let page = list(&connection, &filtered).unwrap();
            assert_eq!(page.total, expected, "search for {term}");
        }
    }

    #[test]
    fn a_search_term_full_of_wildcards_matches_nothing() {
        let store = store_with_three_events();
        let connection = store.lock().unwrap();

        let mut filtered = query();
        filtered.search = "%".to_string();

        let page = list(&connection, &filtered).unwrap();
        assert_eq!(page.total, 0, "an escaped % behaved as a wildcard");
    }

    #[test]
    fn paging_is_stable_and_reports_the_true_total() {
        let store = store_with_three_events();
        let connection = store.lock().unwrap();

        let mut first = query();
        first.limit = 2;
        let page_one = list(&connection, &first).unwrap();
        assert_eq!(page_one.total, 3);
        assert_eq!(page_one.rows.len(), 2);

        let mut second = query();
        second.limit = 2;
        second.offset = 2;
        let page_two = list(&connection, &second).unwrap();
        assert_eq!(page_two.total, 3);
        assert_eq!(page_two.rows.len(), 1);

        // No row appears twice across the two pages.
        assert!(!page_one.rows.iter().any(|row| row.id == page_two.rows[0].id));
    }

    #[test]
    fn job_scoped_reads_are_chronological() {
        let store = store_with_three_events();
        let connection = store.lock().unwrap();

        let events = for_job(&connection, "job_0002").unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].action, "job.retry.approved");

        assert!(for_job(&connection, "job_nope").unwrap().is_empty());
    }

    #[test]
    fn log_stamps_an_id_and_a_timestamp() {
        let store = Store::in_memory().unwrap();
        let connection = store.lock().unwrap();

        let written = log(
            &connection,
            Actor::engine(),
            "engine.started",
            "Recovery engine started",
            AuditSeverity::Info,
            None,
            meta([("version", "1")]),
        )
        .unwrap();

        assert!(written.id.starts_with("evt_"));
        assert!(written.at.ends_with('Z'));

        let stored = list(&connection, &query()).unwrap();
        assert_eq!(stored.rows[0].id, written.id);
        assert_eq!(stored.rows[0].at, written.at);
    }
}
