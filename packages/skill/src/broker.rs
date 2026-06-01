//! Broker channel (ARCHITECTURE.md §7.1) — dumb pipes over HTTP.
//!
//! Synchronous (`ureq` + rustls). The agentic CLI fetches *every* currently-open
//! question each cycle (no cursor); idempotence comes from the ledger, not from
//! a `since` cursor. Submits retry with capped exponential backoff; 4xx is a
//! deterministic rejection and is never retried.

use std::time::Duration;

use crate::models::{DelegationToken, Question};
use crate::Error;

const MAX_BACKOFF_SECS: u64 = 300;

fn trim(base_url: &str) -> &str {
    base_url.trim_end_matches('/')
}

/// `GET /v1/questions/open` with no cursor → every open question.
pub fn fetch_open_questions(base_url: &str) -> Result<Vec<Question>, Error> {
    let url = format!("{}/v1/questions/open", trim(base_url));
    let resp = ureq::get(&url).timeout(Duration::from_secs(15)).call()?;
    let questions: Vec<Question> = resp.into_json()?;
    Ok(questions)
}

fn parse_ack(body: &serde_json::Value) -> (bool, String) {
    let accepted = body
        .get("accepted")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let reason = body
        .get("reason")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    (accepted, reason)
}

/// POST a signed body to `path`, retrying transient failures. Returns
/// `(accepted, reason)`. Mirrors the Python `BrokerClient.submit_*` semantics.
fn post_with_retry(
    base_url: &str,
    path: &str,
    body: &serde_json::Value,
) -> Result<(bool, String), Error> {
    let url = format!("{}{}", trim(base_url), path);
    let mut backoff = 1u64;
    for attempt in 0..5 {
        match ureq::post(&url)
            .timeout(Duration::from_secs(20))
            .send_json(body.clone())
        {
            Ok(resp) => {
                let payload: serde_json::Value =
                    resp.into_json().unwrap_or(serde_json::Value::Null);
                return Ok(parse_ack(&payload));
            }
            Err(ureq::Error::Status(code, resp)) => {
                if (500..600).contains(&code) {
                    std::thread::sleep(Duration::from_secs(backoff.min(MAX_BACKOFF_SECS)));
                    backoff = backoff.saturating_mul(2);
                    continue;
                }
                // 4xx: deterministic rejection — do not retry.
                let reason = resp
                    .into_json::<serde_json::Value>()
                    .ok()
                    .and_then(|p| p.get("reason").and_then(|v| v.as_str()).map(String::from))
                    .unwrap_or_else(|| format!("HTTP {code}"));
                return Ok((false, reason));
            }
            Err(ureq::Error::Transport(t)) => {
                let _ = attempt;
                std::thread::sleep(Duration::from_secs(backoff.min(MAX_BACKOFF_SECS)));
                backoff = backoff.saturating_mul(2);
                let _ = t;
                continue;
            }
        }
    }
    Ok((false, "max retries exhausted".to_string()))
}

/// `POST /v1/envelopes`. A normal answer carries exactly the five canonical
/// fields; a no-signal envelope (§1.14) adds the optional `no_signal` flag. We
/// accept either canonical shape and reject anything else, so a normal answer's
/// wire body stays byte-identical to before.
pub fn submit_envelope(base_url: &str, body: &serde_json::Value) -> Result<(bool, String), Error> {
    let expected: &[&str] = if body.get("no_signal").is_some() {
        &[
            "question_id",
            "answer",
            "no_signal",
            "nonce",
            "delegation_token",
            "agent_signature",
        ]
    } else {
        &[
            "question_id",
            "answer",
            "nonce",
            "delegation_token",
            "agent_signature",
        ]
    };
    assert_keys(body, expected)?;
    post_with_retry(base_url, "/v1/envelopes", body)
}

/// `POST /v1/envelopes/revoke` (§1.12). Three canonical fields.
pub fn submit_revocation(
    base_url: &str,
    body: &serde_json::Value,
) -> Result<(bool, String), Error> {
    assert_keys(
        body,
        &["question_id", "delegation_token", "revocation_signature"],
    )?;
    post_with_retry(base_url, "/v1/envelopes/revoke", body)
}

/// `POST /v1/register` — the install-only enrollment call. Returns the issued
/// delegation token. Used by onboarding.
pub fn register(
    base_url: &str,
    self_proofs: serde_json::Value,
    agent_key_b64: &str,
) -> Result<DelegationToken, Error> {
    let url = format!("{}/v1/register", trim(base_url));
    let body = serde_json::json!({ "self_proofs": self_proofs, "agent_key": agent_key_b64 });
    let resp = ureq::post(&url)
        .timeout(Duration::from_secs(30))
        .send_json(body)?;
    let ack: serde_json::Value = resp.into_json()?;
    if !ack
        .get("accepted")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        let reason = ack
            .get("reason")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        return Err(format!("broker rejected registration: {reason}").into());
    }
    let token = ack
        .get("delegation_token")
        .cloned()
        .filter(|v| !v.is_null())
        .ok_or("broker accepted but returned no delegation_token")?;
    DelegationToken::from_value(token)
}

/// Defensive: refuse to send a body with non-canonical field set.
fn assert_keys(body: &serde_json::Value, expected: &[&str]) -> Result<(), Error> {
    let obj = body
        .as_object()
        .ok_or("envelope body must be a JSON object")?;
    let mut keys: Vec<&str> = obj.keys().map(|s| s.as_str()).collect();
    keys.sort_unstable();
    let mut want: Vec<&str> = expected.to_vec();
    want.sort_unstable();
    if keys != want {
        return Err(format!("refusing to submit body with non-canonical fields: {keys:?}").into());
    }
    Ok(())
}
