//! Error type for the recovery engine.
//!
//! Commands hand the UI a plain `String` (see [`crate::commands`]), because the
//! React screens render whatever they are given verbatim in a callout. The
//! variants below exist so the *message* is written once, next to the condition
//! that produces it, rather than assembled at each call site.

use std::fmt;

/// Anything that can go wrong between the webview and SQLite.
#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    /// The store could not be opened or migrated. Fatal at startup.
    #[error("the recovery store could not be opened: {0}")]
    Store(String),

    #[error("the recovery store rejected the query: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("could not read stored JSON for {id}: {source}")]
    Json {
        id: String,
        #[source]
        source: serde_json::Error,
    },

    /// A stored row does not round-trip back into the domain model. Worth
    /// surfacing rather than defaulting: silently coercing bad data is how a
    /// ledger stops matching itself.
    #[error("stored record {id} is malformed: {detail}")]
    Corrupt { id: String, detail: String },

    #[error("recovery job {0} does not exist")]
    UnknownJob(String),

    #[error("playbook {0} does not exist")]
    UnknownPlaybook(String),

    /// A refused state transition, e.g. approving an already-closed job.
    #[error("{0}")]
    Rejected(String),

    #[error("the recovery store lock was poisoned by an earlier panic; restart RazorRC")]
    LockPoisoned,

    #[error("Razorpay is not configured: set {0} in .env")]
    MissingCredential(&'static str),

    /// Phase 1 registers no HTTP transport, so this is the honest answer to any
    /// request that would have gone over the network.
    #[error("no Razorpay transport is registered, so no request was sent")]
    NoTransport,

    #[error("the Razorpay webhook signature did not match")]
    BadSignature,

    #[error("Razorpay returned {status}: {body}")]
    RazorpayStatus { status: u16, body: String },
}

impl EngineError {
    /// Attaches the record id to a JSON failure so a corrupt row can be found.
    pub fn json(id: impl Into<String>, source: serde_json::Error) -> Self {
        EngineError::Json {
            id: id.into(),
            source,
        }
    }

    pub fn corrupt(id: impl Into<String>, detail: impl fmt::Display) -> Self {
        EngineError::Corrupt {
            id: id.into(),
            detail: detail.to_string(),
        }
    }
}

/// What every `#[tauri::command]` returns. `String` on the error side because
/// the frontend's `invoke` rejection carries the message straight into a callout.
pub type CommandResult<T> = Result<T, String>;

pub type EngineResult<T> = Result<T, EngineError>;

/// Converts an engine result into a command result at the IPC boundary.
pub fn to_command<T>(result: EngineResult<T>) -> CommandResult<T> {
    result.map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_read_as_sentences_a_merchant_could_act_on() {
        assert_eq!(
            EngineError::UnknownJob("job_0042".into()).to_string(),
            "recovery job job_0042 does not exist"
        );
        assert_eq!(
            EngineError::MissingCredential("RAZORPAY_KEY_ID").to_string(),
            "Razorpay is not configured: set RAZORPAY_KEY_ID in .env"
        );
        assert_eq!(
            EngineError::NoTransport.to_string(),
            "no Razorpay transport is registered, so no request was sent"
        );
    }

    #[test]
    fn to_command_flattens_into_a_string() {
        let failed: EngineResult<()> = Err(EngineError::LockPoisoned);
        let message = to_command(failed).unwrap_err();
        assert!(message.contains("restart RazorRC"));
    }
}
