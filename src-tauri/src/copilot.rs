//! Gemini-backed, advisory-only recovery copilot.
//!
//! The API key stays in this process.  The webview receives only streamed text
//! events, and the model receives a deliberately PII-free summary of jobs.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::domain::RecoveryJob;

const MODEL: &str = "gemini-3.6-flash";
const PROVIDER: &str = "gemini";
const EVENT: &str = "copilot:stream";
const MAX_PROMPT_CHARS: usize = 4_000;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StreamEvent {
    pub request_id: String,
    pub kind: String,
    pub text: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Serialize)]
struct GeminiRequest {
    contents: Vec<GeminiContent>,
    #[serde(rename = "systemInstruction")]
    system_instruction: GeminiContent,
}

#[derive(Debug, Serialize)]
struct GeminiContent {
    parts: Vec<GeminiPart>,
}

#[derive(Debug, Serialize)]
struct GeminiPart {
    text: String,
}

#[derive(Debug, Deserialize)]
struct GeminiChunk {
    candidates: Option<Vec<GeminiCandidate>>,
}

#[derive(Debug, Deserialize)]
struct GeminiCandidate {
    content: Option<GeminiResponseContent>,
}

#[derive(Debug, Deserialize)]
struct GeminiResponseContent {
    parts: Option<Vec<GeminiResponsePart>>,
}

#[derive(Debug, Deserialize)]
struct GeminiResponsePart {
    text: Option<String>,
}

pub fn configured() -> bool {
    std::env::var("COPILOT_API_KEY")
        .map(|key| !key.trim().is_empty())
        .unwrap_or(false)
}

pub fn redact_prompt(input: &str) -> String {
    // This is defence in depth for free-form questions. Job context below is
    // constructed from an allowlist and never includes customer fields.
    let mut output = String::with_capacity(input.len());
    for token in input.split_whitespace() {
        let digits: String = token.chars().filter(|character| character.is_ascii_digit()).collect();
        let sensitive = token.contains('@')
            // Phone, card, and account-like digit strings should never leave
            // the device, whether or not the user included punctuation.
            || digits.len() >= 7;
        if sensitive {
            output.push_str("[REDACTED]");
        } else {
            output.push_str(token);
        }
        output.push(' ');
    }
    output.trim().chars().take(MAX_PROMPT_CHARS).collect()
}

fn job_summary(job: &RecoveryJob) -> String {
    // Explicit allowlist: never add payment/order IDs, names, email, phone,
    // issuer, gateway description, or attempt notes to this prompt.
    format!(
        "- Job {}: status={:?}; risk={:?}; amount_paise={}; method={:?}; failure={:?}; attempts={}; subscription={}; recovery_score={:.2}; recommended_action={:?}; confidence={:.2}; delay_minutes={}; sla={}",
        job.id, job.status, job.risk_tier, job.payment.amount_paise, job.payment.method,
        job.payment.failure_reason, job.payment.attempt_count, job.payment.is_subscription,
        job.recovery_score, job.recommended_action.kind, job.recommended_action.confidence,
        job.recommended_action.delay_minutes, job.sla_expires_at,
    )
}

fn emit(app: &AppHandle, request_id: &str, kind: &str, text: Option<String>, message: Option<String>) {
    if let Err(error) = app.emit(EVENT, StreamEvent {
        request_id: request_id.to_owned(), kind: kind.to_owned(), text, message,
    }) {
        tracing::error!(request_id, kind, %error, "could not emit copilot stream event");
    }
}

pub async fn stream(app: AppHandle, request_id: String, prompt: String, jobs: Vec<RecoveryJob>) -> Result<(), String> {
    let provider = std::env::var("COPILOT_PROVIDER").unwrap_or_else(|_| PROVIDER.to_owned());
    let key = std::env::var("COPILOT_API_KEY").map_err(|error| {
        tracing::error!(request_id = %request_id, provider = %provider, model = MODEL, key_exists = false, %error, "Gemini API key is unavailable");
        error.to_string()
    })?;
    tracing::debug!(request_id = %request_id, provider = %provider, model = MODEL, key_exists = !key.trim().is_empty(), "starting Gemini copilot request");
    if key.trim().is_empty() {
        let error = "Gemini is not configured. Add COPILOT_API_KEY to the local .env file.".to_owned();
        tracing::error!(request_id = %request_id, provider = %provider, model = MODEL, key_exists = false, error = %error, "Gemini request rejected before transport");
        return Err(error);
    }
    if prompt.trim().is_empty() {
        let error = "Ask the copilot a question before sending.".to_owned();
        tracing::error!(request_id = %request_id, error = %error, "Gemini request rejected for an empty prompt");
        return Err(error);
    }

    let context = jobs.iter().map(job_summary).collect::<Vec<_>>().join("\n");
    let request = GeminiRequest {
        system_instruction: GeminiContent { parts: vec![GeminiPart { text:
            "You are RazorRC's Recovery Copilot. Give concise, evidence-based, advisory-only analysis. You cannot execute, schedule, approve, modify playbooks, contact customers, or claim an action occurred. Clearly label recommendations as requiring human approval. Treat the supplied job summaries as the only data source. Do not request or infer personal data.".to_owned()
        }] },
        contents: vec![GeminiContent { parts: vec![GeminiPart { text: format!(
            "Question: {}\n\nPII-redacted recovery job summaries:\n{}\n\nAnswer with practical next steps and mention relevant job IDs.",
            redact_prompt(&prompt), context
        ) }] }],
    };
    let endpoint = format!("https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent");
    // Keep the secret out of logs, including debug output from this module.
    tracing::debug!(request_id = %request_id, provider = %provider, model = MODEL, request_url = %endpoint, "sending Gemini request");
    let client = reqwest::Client::builder().timeout(Duration::from_secs(60)).build().map_err(|error| {
        tracing::error!(request_id = %request_id, %error, "could not initialise Gemini HTTP client");
        error.to_string()
    })?;
    let response = client
        .post(&endpoint)
        .header("x-goog-api-key", &key)
        .json(&request)
        .send()
        .await
        .map_err(|error| {
            tracing::error!(
                request_id = %request_id,
                model = MODEL,
                is_timeout = error.is_timeout(),
                is_connect = error.is_connect(),
                %error,
                "Gemini HTTP request failed"
            );
            error.to_string()
        })?;

    tracing::debug!(
        request_id = %request_id,
        model = MODEL,
        http_status = %response.status(),
        "Gemini HTTP response received"
    );

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.map_err(|error| {
            tracing::error!(request_id = %request_id, model = MODEL, %error, "could not read Gemini error body");
            error.to_string()
        })?;
        tracing::error!(
            request_id = %request_id,
            model = MODEL,
            http_status = %status,
            gemini_error_body = %body,
            "Gemini returned a non-success response"
        );
        return Err(format!("Gemini returned HTTP {status}: {body}"));
    }

    let parsed: GeminiChunk = response.json().await.map_err(|error| {
        tracing::error!(request_id = %request_id, model = MODEL, %error, "could not parse Gemini JSON response");
        error.to_string()
    })?;

    if let Some(text) = parsed
        .candidates
        .and_then(|c| c.into_iter().next())
        .and_then(|c| c.content)
        .and_then(|c| c.parts)
        .and_then(|p| p.into_iter().filter_map(|part| part.text).next())
    {
        if !text.is_empty() {
            emit(&app, &request_id, "delta", Some(text), None);
        }
    }
    emit(&app, &request_id, "complete", None, None);
    tracing::debug!(request_id = %request_id, model = MODEL, "Gemini copilot stream completed");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::redact_prompt;

    #[test]
    fn redacts_common_contact_tokens() {
        let output = redact_prompt("Email jane@example.com or call +91-9876543210");
        assert!(!output.contains("jane@example.com"));
        assert!(!output.contains("9876543210"));
    }
}
