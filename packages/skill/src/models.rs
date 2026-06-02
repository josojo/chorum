//! Wire-format models (ARCHITECTURE_V0.md §8.5, packages/proto/*).
//!
//! The delegation token is kept as a raw [`serde_json::Value`] rather than a
//! typed struct: its canonical-JSON bytes (and therefore `delegation_hash`) must
//! match exactly what the broker minted, so we preserve the broker's field
//! values verbatim and never re-format them (notably the `issued_at` /
//! `expires_at` timestamp strings). See [`crate::canonical`].

use serde::Deserialize;

use crate::Error;

fn default_options() -> Vec<String> {
    vec!["yes".to_string(), "no".to_string()]
}

/// Question record returned by `GET /v1/questions/open` (proto/question.json).
#[derive(Debug, Clone, Deserialize)]
pub struct Question {
    pub question_id: String,
    pub text: String,
    #[serde(default)]
    pub topic: Option<String>,
    #[serde(default = "default_options")]
    pub options: Vec<String>,
    #[serde(default)]
    pub closes_at: String,
    pub nonce: String,
}

/// Broker-issued, broker-signed session credential (proto/delegation.json).
///
/// Treated as opaque: only the broker can mint or validate it. We hold the raw
/// JSON object and expose cheap accessors for the few fields the skill reads.
#[derive(Debug, Clone)]
pub struct DelegationToken {
    value: serde_json::Value,
}

impl DelegationToken {
    /// Wrap a parsed JSON object, checking the field set is structurally a token.
    pub fn from_value(value: serde_json::Value) -> Result<Self, Error> {
        if !value.is_object() {
            return Err("delegation token must be a JSON object".into());
        }
        let token = Self { value };
        // Required fields presence (the broker validates types/signature).
        for field in [
            "version",
            "scope",
            "unique_identifier",
            "disclosed_predicates",
            "agent_key",
            "issued_at",
            "expires_at",
            "broker_signature",
        ] {
            if token.value.get(field).is_none() {
                return Err(format!("delegation token missing field: {field}").into());
            }
        }
        Ok(token)
    }

    pub fn parse_json(raw: &str) -> Result<Self, Error> {
        let value: serde_json::Value = serde_json::from_str(raw)?;
        Self::from_value(value)
    }

    pub fn as_value(&self) -> &serde_json::Value {
        &self.value
    }

    pub fn into_value(self) -> serde_json::Value {
        self.value
    }

    fn str_field(&self, key: &str) -> &str {
        self.value.get(key).and_then(|v| v.as_str()).unwrap_or("")
    }

    pub fn agent_key(&self) -> &str {
        self.str_field("agent_key")
    }

    pub fn broker_signature(&self) -> &str {
        self.str_field("broker_signature")
    }

    pub fn expires_at(&self) -> &str {
        self.str_field("expires_at")
    }
}
