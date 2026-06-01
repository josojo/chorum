//! Envelope + revocation construction (ARCHITECTURE.md §7.5/§8.5).
//!
//! Builds the five-field envelope POST body and signs it with the agent key.
//! The signature covers `H(question_id | answer | nonce | delegation_hash_hex)`
//! so an envelope can't be replayed against a different question (§1.9). The
//! revocation body is three fields, domain-separated by a `REVOKE` prefix.

use base64::Engine;
use serde_json::json;

use crate::canonical::{revocation_payload, sign_payload};
use crate::crypto::Keypair;
use crate::delegation::hash_of;
use crate::models::DelegationToken;

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Construct + sign an envelope. Returns the exact five-field JSON body.
///
/// `answer_text` (not an `Answer`) is taken on purpose: the local-only rationale
/// must never leak into the envelope.
pub fn build_envelope(
    question_id: &str,
    answer_text: &str,
    nonce: &str,
    token: &DelegationToken,
    agent_key: &Keypair,
) -> serde_json::Value {
    let dhash_hex = hash_of(token);
    let payload = sign_payload(question_id, answer_text, nonce, &dhash_hex);
    let sig = agent_key.sign(&payload);
    json!({
        "question_id": question_id,
        "answer": answer_text,
        "nonce": nonce,
        "delegation_token": token.as_value().clone(),
        "agent_signature": b64(&sig),
    })
}

/// Build the three-field revocation POST body (§1.12).
pub fn build_revocation(
    question_id: &str,
    token: &DelegationToken,
    agent_key: &Keypair,
) -> serde_json::Value {
    let dhash_hex = hash_of(token);
    let sig = agent_key.sign(&revocation_payload(question_id, &dhash_hex));
    json!({
        "question_id": question_id,
        "delegation_token": token.as_value().clone(),
        "revocation_signature": b64(&sig),
    })
}
