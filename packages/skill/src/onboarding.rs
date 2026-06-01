//! Onboarding (ARCHITECTURE.md §8) — verify-once with Self.
//!
//! The one moment the phone produces cryptographic material for the agent:
//! generate the agent key, ask the self-bridge to create one Self request per
//! age threshold (render each as a QR), poll the bridge for the verified proofs,
//! POST them to the broker's `/v1/register`, and store the issued token.

use std::path::Path;
use std::time::{Duration, Instant};

use base64::Engine;

use crate::broker;
use crate::crypto::load_or_create_agent_keypair;
use crate::delegation::{store_delegation, validate_token};
use crate::models::DelegationToken;
use crate::Error;

pub const DEFAULT_PROFILE: &str = "standard";

pub struct OnboardingRequest {
    pub request_id: String,
    pub urls: Vec<String>,
    pub agent_public_key: String, // base64
}

fn trim(url: &str) -> &str {
    url.trim_end_matches('/')
}

/// Generate the agent key (if needed) and create the Self request(s).
pub fn begin_onboarding(
    agent_key_path: &Path,
    bridge_url: &str,
    profile: &str,
) -> Result<OnboardingRequest, Error> {
    let kp = load_or_create_agent_keypair(agent_key_path)?;
    let agent_b64 = base64::engine::general_purpose::STANDARD.encode(kp.public_bytes());
    let body = serde_json::json!({ "agentKey": agent_b64, "profile": profile });
    let resp = ureq::post(&format!("{}/requests", trim(bridge_url)))
        .timeout(Duration::from_secs(30))
        .send_json(body)?;
    let data: serde_json::Value = resp.into_json()?;
    let request_id = data
        .get("requestId")
        .and_then(|v| v.as_str())
        .ok_or("bridge response missing requestId")?
        .to_string();
    let urls = data
        .get("urls")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    Ok(OnboardingRequest {
        request_id,
        urls,
        agent_public_key: agent_b64,
    })
}

/// Render a Self request URL as an ASCII/unicode QR. Falls back to the raw URL
/// if the payload can't be encoded.
pub fn render_qr_ascii(payload: &str) -> String {
    use qrcode::render::unicode;
    match qrcode::QrCode::new(payload.as_bytes()) {
        Ok(code) => code.render::<unicode::Dense1x2>().quiet_zone(true).build(),
        Err(_) => format!("[QR encode failed; open this link instead]\n{payload}\n"),
    }
}

/// Poll the bridge for the proofs, register with the broker, store the token.
#[allow(clippy::too_many_arguments)]
pub fn complete_onboarding(
    bridge_url: &str,
    broker_url: &str,
    request_id: &str,
    agent_public_key: &str,
    delegation_path: &Path,
    timeout_seconds: f64,
) -> Result<DelegationToken, Error> {
    let deadline = Instant::now() + Duration::from_secs_f64(timeout_seconds);
    let url = format!("{}/requests/{}", trim(bridge_url), request_id);
    loop {
        let resp = ureq::get(&url).timeout(Duration::from_secs(30)).call()?;
        let data: serde_json::Value = resp.into_json()?;
        match data.get("status").and_then(|v| v.as_str()) {
            Some("complete") => {
                if !data
                    .get("verified")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
                {
                    return Err("bridge reported a proof did not verify".into());
                }
                let bundles = data
                    .get("bundles")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);
                if bundles.as_array().map(|a| a.is_empty()).unwrap_or(true) {
                    return Err("bridge returned no proof bundles".into());
                }
                let token = broker::register(broker_url, bundles, agent_public_key)?;
                validate_token(&token, Some(agent_public_key))?;
                store_delegation(delegation_path, &token)?;
                return Ok(token);
            }
            Some(status @ ("rejected" | "error")) => {
                let detail = data.get("error").and_then(|v| v.as_str()).unwrap_or("");
                return Err(format!("onboarding {status}: {detail}").into());
            }
            _ => {}
        }
        if Instant::now() > deadline {
            return Err("timed out waiting for the phone to send proofs".into());
        }
        std::thread::sleep(Duration::from_secs(2));
    }
}

/// Accept a broker-issued DelegationToken JSON (dev fixture replay), validate it
/// structurally, and store it like the real flow.
pub fn accept_identity_bundle(
    raw_json: &str,
    delegation_path: &Path,
) -> Result<DelegationToken, Error> {
    let token = DelegationToken::parse_json(raw_json)?;
    validate_token(&token, None)?;
    store_delegation(delegation_path, &token)?;
    Ok(token)
}
