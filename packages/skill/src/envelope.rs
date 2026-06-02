//! Envelope + revocation construction (ARCHITECTURE_V0.md §7.5/§8.5).
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

/// Construct + sign a NO-SIGNAL envelope (ARCHITECTURE_V0.md §1.14).
///
/// Emitted when the agent has no formed view for the user on this question: a
/// first-class "no opinion" data point, not silence. The answer is empty and
/// `no_signal: true` is set. `no_signal` is UNSIGNED metadata — the agent
/// signature still covers `H(question_id | answer | nonce | delegation_hash)`
/// with the empty answer, exactly as a normal envelope would for `answer = ""`,
/// so the signing input and the goldens are unchanged. It only affects the
/// answerer's own credit count (§15.4); answer integrity is §14.
pub fn build_no_signal_envelope(
    question_id: &str,
    nonce: &str,
    token: &DelegationToken,
    agent_key: &Keypair,
) -> serde_json::Value {
    let dhash_hex = hash_of(token);
    let payload = sign_payload(question_id, "", nonce, &dhash_hex);
    let sig = agent_key.sign(&payload);
    json!({
        "question_id": question_id,
        "answer": "",
        "no_signal": true,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::Keypair;
    use crate::models::DelegationToken;
    use serde_json::json;

    fn token() -> DelegationToken {
        DelegationToken::from_value(json!({
            "version": 2,
            "scope": "hearme-v1",
            "unique_identifier": "self:test",
            "disclosed_predicates": { "region": "EU" },
            "agent_key": "vG256kFHAI/bBigaiiQjfTdhkr6dz3ul4zMK9ZQPPMk=",
            "issued_at": "2026-01-01T00:00:00Z",
            "expires_at": "2026-12-31T00:00:00Z",
            "broker_signature": "AAAA",
        }))
        .unwrap()
    }

    #[test]
    fn no_signal_envelope_has_the_canonical_six_field_shape() {
        let kp = Keypair::from_seed(b"AGENT-KEY-FOR-HEARME-TESTING-32B");
        let env = build_no_signal_envelope(
            "11111111-2222-3333-4444-555555555555",
            "nonce-abc",
            &token(),
            &kp,
        );
        let obj = env.as_object().unwrap();
        let mut keys: Vec<&str> = obj.keys().map(|s| s.as_str()).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "agent_signature",
                "answer",
                "delegation_token",
                "no_signal",
                "nonce",
                "question_id"
            ]
        );
        assert_eq!(env["answer"], "");
        assert_eq!(env["no_signal"], true);
    }

    #[test]
    fn no_signal_does_not_change_the_signing_input() {
        // no_signal is UNSIGNED metadata: its signature must equal a normal
        // envelope's signature for the same (question_id, "", nonce, token).
        let kp = Keypair::from_seed(b"AGENT-KEY-FOR-HEARME-TESTING-32B");
        let t = token();
        let ns = build_no_signal_envelope("q-1", "nonce-1", &t, &kp);
        let normal = build_envelope("q-1", "", "nonce-1", &t, &kp);
        assert_eq!(ns["agent_signature"], normal["agent_signature"]);
    }
}
