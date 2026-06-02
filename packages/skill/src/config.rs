//! Skill runtime configuration.
//!
//! Defaults assume the broker runs locally (docker-compose). All file paths sit
//! under `~/.hermes/hearme/` by default; override via env vars with the
//! `HEARME_SKILL_` prefix (mirroring the Python `pydantic-settings` model).

use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct Settings {
    pub broker_url: String,
    /// self-bridge URL used during onboarding (not contacted in steady state).
    pub self_bridge_url: String,
    pub root_dir: PathBuf,
    /// Memory provider selection for the chatgpt-export DB path default.
    pub memory_backend: String,
}

fn env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}

pub fn default_root() -> PathBuf {
    // Sit under the *active* Hermes home so state (delegation token, keys,
    // policy) is scoped to the same profile the gateway runs under. `$HERMES_HOME`
    // is set by Hermes for a named profile, by its wrapper alias, or by our own
    // `--hermes-profile`/`--hermes-home` flags; default to `~/.hermes` otherwise.
    let hermes_home = std::env::var_os("HERMES_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".hermes")
        });
    hermes_home.join("hearme")
}

impl Settings {
    /// Defaults ignoring the environment — mirrors `get_settings().__class__()`
    /// in the Python code (used to decide whether a URL is "explicitly set").
    pub fn defaults() -> Self {
        Self {
            broker_url: "http://localhost:8000".to_string(),
            self_bridge_url: "http://localhost:8787".to_string(),
            root_dir: default_root(),
            memory_backend: "stub".to_string(),
        }
    }

    /// Load settings, applying `HEARME_SKILL_*` env overrides over the defaults.
    pub fn load() -> Self {
        let d = Self::defaults();
        Self {
            broker_url: env("HEARME_SKILL_BROKER_URL").unwrap_or(d.broker_url),
            self_bridge_url: env("HEARME_SKILL_SELF_BRIDGE_URL").unwrap_or(d.self_bridge_url),
            root_dir: env("HEARME_SKILL_ROOT_DIR")
                .map(PathBuf::from)
                .unwrap_or(d.root_dir),
            memory_backend: env("HEARME_SKILL_MEMORY_BACKEND").unwrap_or(d.memory_backend),
        }
    }

    pub fn policy_path(&self) -> PathBuf {
        self.root_dir.join("policy.yaml")
    }
    pub fn delegation_path(&self) -> PathBuf {
        self.root_dir.join("delegation.token")
    }
    pub fn agent_key_path(&self) -> PathBuf {
        self.root_dir.join("agent_key")
    }
    pub fn ledger_path(&self) -> PathBuf {
        self.root_dir.join("ledger.sqlite")
    }
    pub fn chatgpt_memory_path(&self) -> PathBuf {
        self.root_dir.join("chatgpt_memory.sqlite")
    }
}

pub fn get_settings() -> Settings {
    Settings::load()
}
