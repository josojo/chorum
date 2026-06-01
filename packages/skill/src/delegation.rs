//! Delegation token storage + usability checks (ARCHITECTURE.md §7.5).
//!
//! Loads the cached `DelegationToken` from disk. v0 stores it as plaintext JSON
//! with 0600 perms (same at-rest tradeoff as the agent key). If the token is
//! expired or missing, this layer FAILS the request — it must never silently
//! contact the phone (§1.13 phone is enrollment-only).

use std::fs;
use std::path::Path;

use chrono::{DateTime, Utc};

use crate::canonical::delegation_hash_hex;
use crate::crypto::{set_owner_only, with_tmp_suffix};
use crate::models::DelegationToken;
use crate::Error;

/// Why a delegation token can't be used right now.
#[derive(Debug)]
pub enum DelegationError {
    /// No token on disk — the user must run onboarding.
    Missing,
    /// Token present but past its `expires_at`.
    Expired,
    /// Anything else (corrupt file, parse error).
    Other(String),
}

impl std::fmt::Display for DelegationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DelegationError::Missing => write!(f, "no delegation token; run onboarding"),
            DelegationError::Expired => write!(f, "delegation token expired"),
            DelegationError::Other(s) => write!(f, "{s}"),
        }
    }
}

impl std::error::Error for DelegationError {}

/// Persist a token as JSON with 0600 perms (atomic temp-file + rename).
pub fn store_delegation(path: &Path, token: &DelegationToken) -> Result<(), Error> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    // Store the canonical form so a re-read hashes identically.
    let payload = crate::canonical::canonical_json(token.as_value());
    let tmp = with_tmp_suffix(path);
    fs::write(&tmp, payload)?;
    set_owner_only(&tmp)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

pub fn load_delegation(path: &Path) -> Result<DelegationToken, DelegationError> {
    if !path.exists() {
        return Err(DelegationError::Missing);
    }
    let raw = fs::read_to_string(path).map_err(|e| DelegationError::Other(e.to_string()))?;
    DelegationToken::parse_json(&raw).map_err(|e| DelegationError::Other(e.to_string()))
}

/// Raise [`DelegationError::Expired`] if the token cannot be used now.
pub fn assert_usable(token: &DelegationToken) -> Result<(), DelegationError> {
    let expires = token.expires_at();
    let parsed = DateTime::parse_from_rfc3339(expires)
        .map_err(|e| DelegationError::Other(format!("bad expires_at {expires:?}: {e}")))?
        .with_timezone(&Utc);
    if parsed <= Utc::now() {
        return Err(DelegationError::Expired);
    }
    Ok(())
}

/// Load + check in one call. Errors on missing/expired/corrupt.
pub fn load_usable(path: &Path) -> Result<DelegationToken, DelegationError> {
    let token = load_delegation(path)?;
    assert_usable(&token)?;
    Ok(token)
}

/// Lowercase-hex SHA-256 of canonical_json(token). Matches the broker's verifier.
pub fn hash_of(token: &DelegationToken) -> String {
    delegation_hash_hex(token.as_value())
}

/// Cheap local sanity checks on a broker-issued token (mirrors the Python
/// `self_identity.validate_token`). Full validation is the broker's job.
pub fn validate_token(
    token: &DelegationToken,
    expected_agent_key: Option<&str>,
) -> Result<(), Error> {
    if token.broker_signature().is_empty() {
        return Err("token is missing broker_signature".into());
    }
    if let Some(expected) = expected_agent_key {
        if token.agent_key() != expected {
            return Err("token.agent_key does not match this agent's key \
                (token was issued for a different agent)"
                .into());
        }
    }
    Ok(())
}
