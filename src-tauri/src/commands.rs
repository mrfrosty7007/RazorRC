//! The IPC surface.
//!
//! Each function here is one method of the `DataSource` interface in
//! `src/data/repositories.ts`, reached through `src/data/adapters/tauriAdapter.ts`.
//! The command names are the contract between the two halves of the app, so they
//! are spelled out in full rather than generated.
//!
//! Three deliberate choices:
//!
//! * **Errors cross as strings.** [`to_command`] flattens `EngineError` into its
//!   `Display` text, which the screens render verbatim in a callout. The variants
//!   in [`crate::error`] are written to be read by a merchant, not a developer.
//! * **The operator's name comes from the process, not the request.** A webview
//!   cannot claim to be somebody else in the audit trail.
//! * **These are synchronous.** The queries are single-digit-millisecond reads
//!   against a local SQLite file; moving them onto the async runtime would add a
//!   thread hop and a `Send` bound for no measurable gain.

use tauri::{AppHandle, State};

use crate::db::{audit, jobs, metrics, playbooks};
use crate::domain::{
    AttemptEffectiveness, AuditEvent, AuditQuery, DashboardMetrics, EngineStatus, FailureBreakdown,
    Insight, Merchant, MethodBreakdown, Paged, PageRequest, Playbook, QueueFilters, RecoveryJob,
    TrendPoint,
};
use crate::error::{to_command, CommandResult};
use crate::recovery::{engine, insights};
use crate::state::AppState;

// ---------------------------------------------------------------------------
// Dashboard and analytics
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_dashboard_metrics(
    state: State<'_, AppState>,
    window_days: u32,
) -> CommandResult<DashboardMetrics> {
    to_command(state.read(|connection| metrics::dashboard(connection, window_days)))
}

#[tauri::command]
pub fn get_trend(state: State<'_, AppState>, window_days: u32) -> CommandResult<Vec<TrendPoint>> {
    to_command(state.read(|connection| metrics::trend(connection, window_days)))
}

#[tauri::command]
pub fn get_failure_breakdown(
    state: State<'_, AppState>,
    window_days: u32,
) -> CommandResult<Vec<FailureBreakdown>> {
    to_command(state.read(|connection| metrics::failure_breakdown(connection, window_days)))
}

#[tauri::command]
pub fn get_method_breakdown(
    state: State<'_, AppState>,
    window_days: u32,
) -> CommandResult<Vec<MethodBreakdown>> {
    to_command(state.read(|connection| metrics::method_breakdown(connection, window_days)))
}

#[tauri::command]
pub fn get_attempt_effectiveness(
    state: State<'_, AppState>,
    window_days: u32,
) -> CommandResult<Vec<AttemptEffectiveness>> {
    to_command(state.read(|connection| metrics::attempt_effectiveness(connection, window_days)))
}

// ---------------------------------------------------------------------------
// Recovery queue
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_recovery_jobs(
    state: State<'_, AppState>,
    filters: QueueFilters,
    page: PageRequest,
) -> CommandResult<Paged<RecoveryJob>> {
    to_command(state.read(|connection| jobs::list(connection, &filters, &page)))
}

/// `None` rather than an error for a job that no longer exists: the queue screen
/// deep-links by id, and a stale link should show "not found", not a failure.
#[tauri::command]
pub fn get_recovery_job(
    state: State<'_, AppState>,
    job_id: String,
) -> CommandResult<Option<RecoveryJob>> {
    to_command(state.read(|connection| jobs::get(connection, &job_id)))
}

#[tauri::command]
pub fn approve_recommended_action(
    state: State<'_, AppState>,
    job_id: String,
) -> CommandResult<RecoveryJob> {
    to_command(
        state.write(|transaction| jobs::approve(transaction, &job_id, state.operator())),
    )
}

#[tauri::command]
pub fn suppress_recovery_job(
    state: State<'_, AppState>,
    job_id: String,
    reason: String,
) -> CommandResult<RecoveryJob> {
    to_command(state.write(|transaction| {
        jobs::suppress(transaction, &job_id, &reason, state.operator())
    }))
}

#[tauri::command]
pub fn retry_recovery_job_now(
    state: State<'_, AppState>,
    job_id: String,
) -> CommandResult<RecoveryJob> {
    to_command(
        state.write(|transaction| jobs::retry_now(transaction, &job_id, state.operator())),
    )
}

// ---------------------------------------------------------------------------
// Copilot and playbooks
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_insights(state: State<'_, AppState>) -> CommandResult<Vec<Insight>> {
    to_command(state.read(insights::list))
}

#[tauri::command]
pub fn list_playbooks(state: State<'_, AppState>) -> CommandResult<Vec<Playbook>> {
    to_command(state.read(playbooks::list))
}

#[tauri::command]
pub fn set_playbook_enabled(
    state: State<'_, AppState>,
    playbook_id: String,
    enabled: bool,
) -> CommandResult<Playbook> {
    to_command(state.write(|transaction| {
        playbooks::set_enabled(transaction, &playbook_id, enabled, state.operator())
    }))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotStatus { configured: bool, model: &'static str }

#[tauri::command]
pub fn get_copilot_status() -> CopilotStatus {
    CopilotStatus { configured: crate::copilot::configured(), model: "Gemini 2.5 Flash" }
}

/// Streams text as `copilot:stream` events. This command only reads recovery
/// records; it never invokes the recovery engine or changes a playbook.
#[tauri::command]
pub async fn stream_copilot_answer(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: String,
    prompt: String,
    job_ids: Vec<String>,
) -> CommandResult<()> {
    let jobs = state.read(|connection| {
        job_ids.iter().filter_map(|id| jobs::get(connection, id).transpose()).collect()
    }).map_err(|error| error.to_string())?;
    crate::copilot::stream(app, request_id, prompt, jobs).await
}

// ---------------------------------------------------------------------------
// Audit trail and system
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_audit_events(
    state: State<'_, AppState>,
    query: AuditQuery,
) -> CommandResult<Paged<AuditEvent>> {
    to_command(state.read(|connection| audit::list(connection, &query)))
}

#[tauri::command]
pub fn get_engine_status(state: State<'_, AppState>) -> CommandResult<EngineStatus> {
    to_command(engine::status(state.store(), state.engine()))
}

#[tauri::command]
pub fn get_merchant(state: State<'_, AppState>) -> CommandResult<Merchant> {
    Ok(state.merchant())
}
