//! Ed25519 sign/verify + agent-key on-disk storage.
//!
//! Deterministic Ed25519 (RFC 8032) — byte-identical to the broker's
//! TweetNaCl/libsodium signatures for the same 32-byte seed, which the
//! golden-vector tests confirm.
//!
//! STUB (carried over from the Python v0): the 32-byte seed is written to disk
//! with 0600 permissions but NOT encrypted. Anyone with read access to the
//! user's home directory can currently impersonate the agent (ARCHITECTURE_V0.md
//! §13).

use std::fs;
use std::path::Path;

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};

use crate::Result;

/// A loaded agent keypair (32-byte seed + derived public key).
pub struct Keypair {
    signing_key: SigningKey,
}

impl Keypair {
    pub fn generate() -> Result<Self> {
        let mut seed = [0u8; 32];
        getrandom::getrandom(&mut seed).map_err(|e| format!("getrandom failed: {e}"))?;
        Ok(Self {
            signing_key: SigningKey::from_bytes(&seed),
        })
    }

    pub fn from_seed(seed: &[u8; 32]) -> Self {
        Self {
            signing_key: SigningKey::from_bytes(seed),
        }
    }

    /// Raw 32-byte Ed25519 public key.
    pub fn public_bytes(&self) -> [u8; 32] {
        self.signing_key.verifying_key().to_bytes()
    }

    /// The 32-byte seed (private). Used for on-disk persistence only.
    fn seed(&self) -> [u8; 32] {
        self.signing_key.to_bytes()
    }

    /// Raw 64-byte Ed25519 signature over `payload`.
    pub fn sign(&self, payload: &[u8]) -> [u8; 64] {
        self.signing_key.sign(payload).to_bytes()
    }
}

/// Verify a raw 64-byte signature over `payload` with a 32-byte public key.
#[allow(dead_code)]
pub fn verify(public_key: &[u8; 32], payload: &[u8], signature: &[u8; 64]) -> bool {
    let Ok(vk) = VerifyingKey::from_bytes(public_key) else {
        return false;
    };
    vk.verify(payload, &Signature::from_bytes(signature))
        .is_ok()
}

/// Load the agent keypair, creating + persisting a fresh one if absent.
pub fn load_or_create_agent_keypair(path: &Path) -> Result<Keypair> {
    if path.exists() {
        return load_agent_keypair(path);
    }
    let kp = Keypair::generate()?;
    store_agent_keypair(path, &kp)?;
    Ok(kp)
}

pub fn load_agent_keypair(path: &Path) -> Result<Keypair> {
    let bytes = fs::read(path)?;
    let seed: [u8; 32] = bytes.as_slice().try_into().map_err(|_| {
        format!(
            "Agent key at {} is {} bytes; expected 32.",
            path.display(),
            bytes.len()
        )
    })?;
    Ok(Keypair::from_seed(&seed))
}

/// Atomic write of the 32-byte seed with 0600 perms (temp file + rename).
pub fn store_agent_keypair(path: &Path, keypair: &Keypair) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = with_tmp_suffix(path);
    fs::write(&tmp, keypair.seed())?;
    set_owner_only(&tmp)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

pub(crate) fn with_tmp_suffix(path: &Path) -> std::path::PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(".tmp");
    std::path::PathBuf::from(s)
}

#[cfg(unix)]
pub(crate) fn set_owner_only(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(not(unix))]
pub(crate) fn set_owner_only(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    // Agent keypair seed from packages/broker/tests/goldens.test.ts: the 32
    // ASCII bytes of "AGENT-KEY-FOR-HEARME-TESTING-32B".
    const SEED: &[u8; 32] = b"AGENT-KEY-FOR-HEARME-TESTING-32B";
    const AGENT_PUB_B64: &str = "vG256kFHAI/bBigaiiQjfTdhkr6dz3ul4zMK9ZQPPMk=";

    #[test]
    fn public_key_matches_broker_golden() {
        let kp = Keypair::from_seed(SEED);
        let got = base64::engine::general_purpose::STANDARD.encode(kp.public_bytes());
        assert_eq!(got, AGENT_PUB_B64);
    }

    #[test]
    fn produces_broker_verifiable_envelope_signature() {
        // The exact signing input from the broker golden, then sign it.
        let kp = Keypair::from_seed(SEED);
        let digest = crate::canonical::sign_payload(
            "11111111-2222-3333-4444-555555555555",
            "yes",
            "nonce-abc",
            "03e9bf5601d898df94914f61003abf783e62b7a0a92c1f2bde32b529a0355717",
        );
        let sig = kp.sign(&digest);
        let sig_b64 = base64::engine::general_purpose::STANDARD.encode(sig);
        assert_eq!(
            sig_b64,
            "dGnBfOhWyo7S6PNqr0SUGPu5Lk1THJEZ80Wp3Y2+KTfGMR/zS4T9WknXFvwvxn1ma6y+7C9fGBZLGwoF7dhTBQ=="
        );
        // And it verifies under our own verifier.
        assert!(verify(&kp.public_bytes(), &digest, &sig));
    }

    #[test]
    fn produces_broker_verifiable_revocation_signature() {
        let kp = Keypair::from_seed(SEED);
        let digest = crate::canonical::revocation_payload(
            "11111111-2222-3333-4444-555555555555",
            "03e9bf5601d898df94914f61003abf783e62b7a0a92c1f2bde32b529a0355717",
        );
        let sig_b64 = base64::engine::general_purpose::STANDARD.encode(kp.sign(&digest));
        assert_eq!(
            sig_b64,
            "IRHlY3omUKleOAKchmQe+TwZ2Pdd1D7afshfNaA9B6fsGMmdZfDhukisxpwMnCa3ro9yGUNGSdDy4qp2vwEqDg=="
        );
    }
}
