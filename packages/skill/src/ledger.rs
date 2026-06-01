//! Local ledger (ARCHITECTURE.md §7.6) — SQLite via rusqlite.
//!
//! Schema: `questions`, `answers`, `submissions`, `revocations`,
//! `question_spend`, `meta`. Primary key on `question_id` everywhere.
//!
//! STUB (carried over from v0): the ledger is not encrypted at rest — host
//! compromise == ledger leak.

use std::collections::HashSet;
use std::path::Path;

use chrono::Utc;
use rusqlite::Connection;

use crate::Error;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS questions (
    question_id TEXT PRIMARY KEY,
    text        TEXT NOT NULL,
    topic       TEXT,
    closes_at   TEXT NOT NULL,
    nonce       TEXT NOT NULL,
    received_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS answers (
    question_id TEXT PRIMARY KEY REFERENCES questions(question_id),
    answer_text TEXT NOT NULL,
    rationale   TEXT NOT NULL,
    created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS submissions (
    question_id     TEXT PRIMARY KEY REFERENCES questions(question_id),
    delegation_hash TEXT NOT NULL,
    agent_signature TEXT NOT NULL,
    submitted_at    TEXT NOT NULL,
    accepted        INTEGER NOT NULL DEFAULT 0,
    reason          TEXT
);
CREATE TABLE IF NOT EXISTS revocations (
    delegation_hash TEXT PRIMARY KEY,
    revoked_at      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS question_spend (
    day           TEXT PRIMARY KEY,
    answer_count  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
";

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

fn today_utc() -> String {
    Utc::now().format("%Y-%m-%d").to_string()
}

#[derive(Debug, Clone)]
pub struct SubmissionRecord {
    pub question_id: String,
    pub submitted_at: String,
    pub accepted: bool,
    pub reason: Option<String>,
}

pub struct Ledger {
    conn: Connection,
}

impl Ledger {
    /// Open (creating parent dir + schema). Mirrors `Ledger.open()`.
    pub fn open(path: &Path) -> Result<Self, Error> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self { conn })
    }

    pub fn record_question(
        &self,
        question_id: &str,
        text: &str,
        topic: Option<&str>,
        closes_at: &str,
        nonce: &str,
    ) -> Result<(), Error> {
        self.conn.execute(
            "INSERT OR IGNORE INTO questions(question_id, text, topic, closes_at, nonce, received_at)\
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![question_id, text, topic, closes_at, nonce, now_iso()],
        )?;
        Ok(())
    }

    pub fn record_answer(
        &self,
        question_id: &str,
        answer_text: &str,
        rationale: &str,
    ) -> Result<(), Error> {
        self.conn.execute(
            "INSERT OR REPLACE INTO answers(question_id, answer_text, rationale, created_at)\
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![question_id, answer_text, rationale, now_iso()],
        )?;
        Ok(())
    }

    pub fn record_submission(
        &self,
        question_id: &str,
        delegation_hash_hex: &str,
        agent_signature_b64: &str,
        accepted: bool,
        reason: Option<&str>,
    ) -> Result<(), Error> {
        self.conn.execute(
            "INSERT OR REPLACE INTO submissions\
             (question_id, delegation_hash, agent_signature, submitted_at, accepted, reason)\
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                question_id,
                delegation_hash_hex,
                agent_signature_b64,
                now_iso(),
                accepted as i64,
                reason
            ],
        )?;
        if accepted {
            self.conn.execute(
                "INSERT INTO question_spend(day, answer_count) VALUES (?1, 1)\
                 ON CONFLICT(day) DO UPDATE SET answer_count = answer_count + 1",
                rusqlite::params![today_utc()],
            )?;
        }
        Ok(())
    }

    pub fn has_submission(&self, question_id: &str) -> Result<bool, Error> {
        let n: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM submissions WHERE question_id = ?1 AND accepted = 1",
            rusqlite::params![question_id],
            |r| r.get(0),
        )?;
        Ok(n > 0)
    }

    pub fn answered_today(&self) -> Result<i64, Error> {
        let count: Option<i64> = self
            .conn
            .query_row(
                "SELECT answer_count FROM question_spend WHERE day = ?1",
                rusqlite::params![today_utc()],
                |r| r.get(0),
            )
            .ok();
        Ok(count.unwrap_or(0))
    }

    pub fn already_answered_ids(&self) -> Result<HashSet<String>, Error> {
        let mut stmt = self
            .conn
            .prepare("SELECT question_id FROM submissions WHERE accepted = 1")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = HashSet::new();
        for r in rows {
            out.insert(r?);
        }
        Ok(out)
    }

    pub fn list_recent_submissions(&self, limit: i64) -> Result<Vec<SubmissionRecord>, Error> {
        let mut stmt = self.conn.prepare(
            "SELECT question_id, submitted_at, accepted, reason FROM submissions \
             ORDER BY submitted_at DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(rusqlite::params![limit], |r| {
            Ok(SubmissionRecord {
                question_id: r.get(0)?,
                submitted_at: r.get(1)?,
                accepted: r.get::<_, i64>(2)? != 0,
                reason: r.get(3)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// `(text, topic, closes_at)` recorded for a question, if any.
    pub fn question_meta(
        &self,
        question_id: &str,
    ) -> Result<Option<(String, Option<String>, String)>, Error> {
        let r = self
            .conn
            .query_row(
                "SELECT text, topic, closes_at FROM questions WHERE question_id = ?1",
                rusqlite::params![question_id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, Option<String>>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                },
            )
            .ok();
        Ok(r)
    }

    pub fn answer_text(&self, question_id: &str) -> Result<Option<String>, Error> {
        let r = self
            .conn
            .query_row(
                "SELECT answer_text FROM answers WHERE question_id = ?1",
                rusqlite::params![question_id],
                |r| r.get::<_, String>(0),
            )
            .ok();
        Ok(r)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_ledger() -> (tempfile::TempDir, Ledger) {
        let dir = tempfile::tempdir().unwrap();
        let ledger = Ledger::open(&dir.path().join("ledger.sqlite")).unwrap();
        (dir, ledger)
    }

    // Regression: list_recent_submissions once built `FROM submissions\` glued to
    // `ORDER BY` (a Rust string line-continuation eats the newline AND the next
    // line's indentation), yielding `submissionsORDER` — a SQL syntax error that
    // broke `review-answers`. This exercises the full record -> read round-trip.
    #[test]
    fn list_recent_submissions_round_trips() {
        let (_dir, ledger) = temp_ledger();
        ledger
            .record_question("q1", "Q one", Some("ai"), "2030-01-01T00:00:00Z", "n1")
            .unwrap();
        ledger.record_answer("q1", "Yes", "").unwrap();
        ledger
            .record_submission("q1", "dhash", "sig", true, None)
            .unwrap();

        let recent = ledger.list_recent_submissions(20).unwrap();
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].question_id, "q1");
        assert!(recent[0].accepted);
    }
}
