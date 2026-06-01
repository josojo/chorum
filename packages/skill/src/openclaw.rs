//! OpenClaw host adapter — skill install + cron registration.
//!
//! OpenClaw's extension unit is a `SKILL.md` directory whose instructions tell
//! the host agent to run our CLI via its built-in `exec` tool. So the only
//! OpenClaw-specific code is "drop the skill dir + register a cron job" — all
//! identity/policy/signing logic stays in the shared core ([`crate::tools`]).

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::Error;

pub const SKILL_NAME: &str = "hearme";
pub const CRON_NAME: &str = "hearme-answer-cycle";
pub const DEFAULT_SCHEDULE: &str = "0 9 * * *";
pub const CRON_MESSAGE: &str =
    "Answer any open Hearme questions on my behalf using the hearme skill, then stop.";

/// Canonical SKILL.md — embedded from the committed copy so the file
/// `openclaw skills install ./...` reads and the file the installer writes can
/// never drift (they are the same bytes by construction).
pub const SKILL_MD: &str = include_str!("../openclaw/hearme/SKILL.md");

pub fn openclaw_root() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".openclaw")
}

pub fn openclaw_skills_dir() -> PathBuf {
    openclaw_root().join("skills")
}

pub fn openclaw_env_path() -> PathBuf {
    openclaw_root().join(".env")
}

/// Is OpenClaw installed on this box? True if the CLI is on PATH or `~/.openclaw`
/// exists. Used by the host-aware install flow.
pub fn openclaw_available() -> bool {
    which("openclaw").is_some() || openclaw_root().exists()
}

/// Write the OpenClaw skill drop-in. Idempotent (always overwrites SKILL.md).
/// Returns the skill directory.
pub fn install_openclaw_skill(skills_dir_override: Option<&Path>) -> Result<PathBuf, Error> {
    let base = skills_dir_override
        .map(|p| p.to_path_buf())
        .unwrap_or_else(openclaw_skills_dir);
    let target = base.join(SKILL_NAME);
    std::fs::create_dir_all(&target)?;
    std::fs::write(target.join("SKILL.md"), SKILL_MD)?;
    Ok(target)
}

/// Outcome of [`ensure_openclaw_cron`], mirroring the Python dict result.
#[derive(Debug)]
pub struct CronResult {
    pub created: bool,
    pub skipped: bool,
    pub name: Option<String>,
    pub reason: Option<String>,
}

/// Register the recurring answering run with OpenClaw's scheduler. Best-effort;
/// never errors out — the caller prints a hint if it couldn't run.
pub fn ensure_openclaw_cron(schedule: Option<&str>, message: Option<&str>) -> CronResult {
    let Some(exe) = which("openclaw") else {
        return CronResult {
            created: false,
            skipped: true,
            name: None,
            reason: Some("openclaw CLI not found on PATH".to_string()),
        };
    };
    let sched = schedule.unwrap_or(DEFAULT_SCHEDULE);
    let msg = message.unwrap_or(CRON_MESSAGE);

    // Idempotency: skip if a job with our name already exists.
    if let Ok(out) = Command::new(&exe).args(["cron", "list"]).output() {
        if String::from_utf8_lossy(&out.stdout).contains(CRON_NAME) {
            return CronResult {
                created: false,
                skipped: false,
                name: Some(CRON_NAME.into()),
                reason: Some("already present".into()),
            };
        }
    }

    match Command::new(&exe)
        .args([
            "cron",
            "add",
            "--name",
            CRON_NAME,
            "--cron",
            sched,
            "--session",
            "isolated",
            "--message",
            msg,
        ])
        .output()
    {
        Ok(out) if out.status.success() => CronResult {
            created: true,
            skipped: false,
            name: Some(CRON_NAME.into()),
            reason: None,
        },
        Ok(out) => {
            let detail = String::from_utf8_lossy(&out.stderr);
            let detail = detail.trim();
            let reason = if detail.is_empty() {
                format!("exit {}", out.status.code().unwrap_or(-1))
            } else {
                detail.to_string()
            };
            CronResult {
                created: false,
                skipped: true,
                name: Some(CRON_NAME.into()),
                reason: Some(reason),
            }
        }
        Err(e) => CronResult {
            created: false,
            skipped: true,
            name: Some(CRON_NAME.into()),
            reason: Some(e.to_string()),
        },
    }
}

/// Minimal `which`: first executable named `name` on `PATH`.
pub fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skill_md_frontmatter_shape() {
        assert!(SKILL_MD.starts_with("---\n"));
        assert!(SKILL_MD.contains("\nname: hearme\n"));
        let meta_line = SKILL_MD
            .lines()
            .find(|l| l.starts_with("metadata:"))
            .unwrap();
        let json_part = meta_line.trim_start_matches("metadata:").trim();
        let _: serde_json::Value = serde_json::from_str(json_part).unwrap();
        assert!(SKILL_MD.contains("hearme-skill list-questions"));
        assert!(SKILL_MD.contains("hearme-skill submit-answer"));
    }

    #[test]
    fn install_writes_skill_md() {
        let dir = tempfile::tempdir().unwrap();
        let target = install_openclaw_skill(Some(dir.path())).unwrap();
        assert_eq!(target, dir.path().join("hearme"));
        assert_eq!(
            std::fs::read_to_string(target.join("SKILL.md")).unwrap(),
            SKILL_MD
        );
    }
}
