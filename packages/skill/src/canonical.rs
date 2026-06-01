//! Canonical JSON + hashing.
//!
//! Both packages (this skill and the TypeScript broker) must produce
//! byte-identical canonical JSON for the same value. Rules:
//!
//! * UTF-8.
//! * Object keys sorted (recursive).
//! * No insignificant whitespace (compact `,`/`:` separators).
//! * Non-ASCII text encoded directly (no `\uXXXX` escaping).
//!
//! `serde_json` satisfies all four out of the box *as long as the default
//! `Map` type (a `BTreeMap`) is used* — i.e. the `preserve_order` feature must
//! NOT be enabled (see Cargo.toml). `serde_json::to_string` emits compact
//! output and escapes exactly the JSON-mandated set (`"`, `\`, control chars),
//! matching JavaScript's `JSON.stringify`. The golden-vector tests pin this
//! against the broker's `canonicalJson`.

use sha2::{Digest, Sha256};

/// Canonical JSON text for `value` (sorted keys, no whitespace, raw UTF-8).
pub fn canonical_json(value: &serde_json::Value) -> String {
    // `serde_json::Value`'s map is a `BTreeMap` (default features), so
    // serialization is already key-sorted and recursive; `to_string` is compact.
    serde_json::to_string(value).expect("serializing a serde_json::Value cannot fail")
}

pub fn canonical_json_bytes(value: &serde_json::Value) -> Vec<u8> {
    canonical_json(value).into_bytes()
}

/// SHA-256 over `canonical_json(delegation_token)`. Returns the raw 32-byte
/// digest (callers hex-encode for the signing input).
pub fn delegation_hash(token: &serde_json::Value) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(canonical_json_bytes(token));
    hasher.finalize().into()
}

/// Lowercase hex of [`delegation_hash`].
pub fn delegation_hash_hex(token: &serde_json::Value) -> String {
    hex_encode(&delegation_hash(token))
}

/// `H(question_id | answer | nonce | delegation_hash_hex)`.
///
/// Byte layout MUST match the broker's `envelopeSigningInput`: the four UTF-8
/// components joined with a single ASCII `|` (0x7C) separator, then SHA-256'd
/// to a 32-byte digest. `delegation_hash_hex` is the hex string form. Any drift
/// here causes `agent_signature_invalid` rejections at the broker.
pub fn sign_payload(
    question_id: &str,
    answer: &str,
    nonce: &str,
    delegation_hash_hex: &str,
) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(question_id.as_bytes());
    hasher.update(b"|");
    hasher.update(answer.as_bytes());
    hasher.update(b"|");
    hasher.update(nonce.as_bytes());
    hasher.update(b"|");
    hasher.update(delegation_hash_hex.as_bytes());
    hasher.finalize().into()
}

/// `H("REVOKE" | question_id | delegation_hash_hex)`.
///
/// Byte layout MUST match the broker's `revocationSigningInput`: the literal
/// `REVOKE` domain-separator prefix + the two UTF-8 components, joined with a
/// single ASCII `|` separator, SHA-256'd to 32 bytes. The `REVOKE` prefix
/// prevents a captured envelope signature from being replayed as a revocation.
pub fn revocation_payload(question_id: &str, delegation_hash_hex: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"REVOKE");
    hasher.update(b"|");
    hasher.update(question_id.as_bytes());
    hasher.update(b"|");
    hasher.update(delegation_hash_hex.as_bytes());
    hasher.finalize().into()
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Golden vectors copied verbatim from packages/broker/tests/goldens.test.ts.
    // These pin byte-for-byte cross-language compatibility with the broker.
    const GOLDEN_TOKEN: &str = r#"{
        "version": 2,
        "scope": "hearme-v1",
        "unique_identifier": "self:nullifier-1",
        "disclosed_predicates": {"region": "EU", "country": "DE", "age_band": "35-49"},
        "agent_key": "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
        "issued_at": "2026-05-31T12:00:00.123456Z",
        "expires_at": "2026-08-29T12:00:00.123456Z",
        "broker_signature": "liH3VGMdnr/MXqqAlxxrIol32jL4Fq43oVeoKpm1Du6mD3JvpjUELKwe/nKeJYrQVflmLp8WOCEnF307TpzaBQ=="
    }"#;
    const GOLDEN_HASH_HEX: &str =
        "03e9bf5601d898df94914f61003abf783e62b7a0a92c1f2bde32b529a0355717";
    const QID: &str = "11111111-2222-3333-4444-555555555555";
    const DHASH: &str = "03e9bf5601d898df94914f61003abf783e62b7a0a92c1f2bde32b529a0355717";

    #[test]
    fn canonical_json_sorts_and_compacts() {
        let v = json!({"b": 1, "a": {"d": 2, "c": 3}});
        assert_eq!(canonical_json(&v), r#"{"a":{"c":3,"d":2},"b":1}"#);
    }

    #[test]
    fn canonical_json_keeps_non_ascii_raw() {
        let v = json!({"x": "café"});
        assert_eq!(canonical_json(&v), "{\"x\":\"café\"}");
    }

    #[test]
    fn delegation_hash_matches_broker_golden() {
        let token: serde_json::Value = serde_json::from_str(GOLDEN_TOKEN).unwrap();
        assert_eq!(
            canonical_json(&token),
            r#"{"agent_key":"AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=","broker_signature":"liH3VGMdnr/MXqqAlxxrIol32jL4Fq43oVeoKpm1Du6mD3JvpjUELKwe/nKeJYrQVflmLp8WOCEnF307TpzaBQ==","disclosed_predicates":{"age_band":"35-49","country":"DE","region":"EU"},"expires_at":"2026-08-29T12:00:00.123456Z","issued_at":"2026-05-31T12:00:00.123456Z","scope":"hearme-v1","unique_identifier":"self:nullifier-1","version":2}"#
        );
        assert_eq!(delegation_hash_hex(&token), GOLDEN_HASH_HEX);
    }

    #[test]
    fn envelope_signing_input_matches_broker_golden() {
        let digest = sign_payload(QID, "yes", "nonce-abc", DHASH);
        assert_eq!(
            hex_encode(&digest),
            "346283939cf650d944d0f2818751d697baee48c813e5329aa7ac5de9599ed7b4"
        );
    }

    #[test]
    fn revocation_signing_input_matches_broker_golden() {
        let digest = revocation_payload(QID, DHASH);
        assert_eq!(
            hex_encode(&digest),
            "affd6504090e1d643114ff1e684d2b76e658415fc4e8949f1fe37d5706307182"
        );
    }
}
