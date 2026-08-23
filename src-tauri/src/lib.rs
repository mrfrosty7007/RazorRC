//! ReviveAI, Rust side.
//!
//! The desktop app is assembled here: open the store, migrate it, install
//! defaults, start the sweep thread, and expose the sixteen commands the React
//! app calls. Nothing in this file makes a product decision — those live in
//! [`recovery::rules`] and are tested without a webview, which is why the app is
//! a library with a three-line binary rather than one big `main`.
//!
//! Modules are public so `cargo test` can exercise the engine directly.

pub mod bootstrap;
pub mod clock;
pub mod copilot;
pub mod commands;
pub mod db;
pub mod domain;
pub mod error;
pub mod recovery;
pub mod state;

use std::path::PathBuf;
use std::sync::Arc;

use tauri::Manager;

use crate::db::{audit, Store, DB_PATH_ENV};
use crate::domain::{Actor, AuditSeverity};
use crate::recovery::engine::{self, EngineHandle};
use crate::state::AppState;

type Startup<T> = Result<T, Box<dyn std::error::Error>>;

/// Renders any startup failure as a plain sentence. The app cannot usefully
/// continue past one of these, so the only job left is to say what went wrong.
fn to_startup_message<E: std::fmt::Display>(error: E) -> String {
    error.to_string()
}

/// Entry point, called by `main`.
pub fn run() {
    // A missing `.env` is normal: the app runs without Razorpay credentials and
    // says so in the sidebar rather than refusing to start.
    let _ = dotenvy::dotenv();

    let app = tauri::Builder::default()
        .setup(|app| {
            // Startup errors are flattened to strings on the way out. `String`
            // converts into every flavour of boxed error, so this closure does
            // not care whether Tauri's setup hook asks for `Box<dyn Error>` or
            // `Box<dyn Error + Send + Sync>`, and the message the operator sees
            // is the same either way.
            let store = Arc::new(open_store(app.handle()).map_err(to_startup_message)?);
            let seeded = bootstrap::install(&store).map_err(to_startup_message)?;
            announce_startup(&store, seeded).map_err(to_startup_message)?;

            let engine_handle = Arc::new(EngineHandle::new());
            engine::spawn(Arc::clone(&store), Arc::clone(&engine_handle));

            app.manage(AppState::new(
                store,
                engine_handle,
                bootstrap::merchant(),
            ));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_dashboard_metrics,
            commands::get_trend,
            commands::get_failure_breakdown,
            commands::get_method_breakdown,
            commands::get_attempt_effectiveness,
            commands::list_recovery_jobs,
            commands::get_recovery_job,
            commands::approve_recommended_action,
            commands::suppress_recovery_job,
            commands::retry_recovery_job_now,
            commands::list_insights,
            commands::list_playbooks,
            commands::set_playbook_enabled,
            commands::get_copilot_status,
            commands::stream_copilot_answer,
            commands::list_audit_events,
            commands::get_engine_status,
            commands::get_merchant,
        ])
        .build(tauri::generate_context!())
        .expect("ReviveAI could not start");

    app.run(|handle, event| {
        // Ask the sweep to finish its tick before the process goes away, so a
        // transition in flight commits rather than being rolled back on exit.
        if let tauri::RunEvent::ExitRequested { .. } = event {
            if let Some(state) = handle.try_state::<AppState>() {
                state.engine().request_stop();
            }
        }
    });
}

/// Opens the store, honouring [`DB_PATH_ENV`] so a throwaway database can be
/// pointed at without touching the real one.
fn open_store(app: &tauri::AppHandle) -> Startup<Store> {
    if let Some(path) = std::env::var(DB_PATH_ENV)
        .ok()
        .map(|value| PathBuf::from(value.trim()))
        .filter(|path| !path.as_os_str().is_empty())
    {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        return Ok(Store::open_at(&path)?);
    }

    let directory = app.path().app_data_dir()?;
    Ok(Store::open_in(&directory)?)
}

/// One line in the trail per launch. Cheap, and it means the audit screen can
/// answer "was the engine even running on Tuesday?".
fn announce_startup(store: &Store, seeded: usize) -> Startup<()> {
    let connection = store.lock()?;

    audit::log(
        &connection,
        Actor::scheduler(),
        "system.startup",
        format!(
            "ReviveAI started against {}",
            store.path().display()
        ),
        AuditSeverity::Info,
        None,
        audit::meta([
            ("store", store.path().display().to_string()),
            ("demo_jobs_seeded", seeded.to_string()),
        ]),
    )?;

    Ok(())
}
