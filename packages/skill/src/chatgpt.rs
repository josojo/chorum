//! Local memory backed by a user-supplied ChatGPT data export.
//!
//! Supported path: explicit user export -> local import -> local SQLite FTS5
//! lookup. The database stays on the user's machine. This is a functional port
//! of the Python `memory.chatgpt_export` module (the snippet wording need not be
//! byte-identical, only useful).

use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};

use regex::Regex;
use rusqlite::Connection;

use crate::Error;

pub struct ImportStats {
    pub conversations: usize,
    pub chunks: usize,
    pub db_path: PathBuf,
}

struct Chunk {
    title: String,
    role: String,
    text: String,
    conversation_id: String,
    created_at: Option<f64>,
}

fn token_re() -> Regex {
    Regex::new(r"[A-Za-z][A-Za-z0-9_+\-]{2,}").unwrap()
}

fn clean_text(text: &str) -> String {
    let no_nul = text.replace('\u{0}', " ");
    let ws = Regex::new(r"\s+").unwrap();
    ws.replace_all(&no_nul, " ").trim().to_string()
}

fn truncate(text: &str, max_chars: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max_chars {
        return text.to_string();
    }
    let cut: String = chars[..max_chars.saturating_sub(1)].iter().collect();
    format!("{}...", cut.trim_end())
}

fn clean_title(text: &str) -> String {
    let t = truncate(&clean_text(text), 80);
    if t.is_empty() {
        "Untitled ChatGPT chat".to_string()
    } else {
        t
    }
}

/// Split into sentence-ish pieces (Rust's regex has no lookbehind, so we scan).
fn split_sentences(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let chars: Vec<char> = text.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        cur.push(c);
        if matches!(c, '.' | '!' | '?') {
            if let Some(&next) = chars.get(i + 1) {
                if next.is_whitespace() {
                    out.push(cur.trim().to_string());
                    cur.clear();
                }
            }
        }
    }
    if !cur.trim().is_empty() {
        out.push(cur.trim().to_string());
    }
    out
}

fn chunk_text(text: &str, max_chars: usize) -> Vec<String> {
    if text.chars().count() <= max_chars {
        return vec![text.to_string()];
    }
    let mut out = Vec::new();
    let mut buf = String::new();
    for sentence in split_sentences(text) {
        if buf.chars().count() + sentence.chars().count() + 1 > max_chars && !buf.is_empty() {
            out.push(buf.trim().to_string());
            buf = sentence;
        } else if buf.is_empty() {
            buf = sentence;
        } else {
            buf = format!("{buf} {sentence}");
        }
    }
    if !buf.trim().is_empty() {
        out.push(buf.trim().to_string());
    }
    out
}

fn message_text(msg: &serde_json::Value) -> String {
    let parts = msg
        .get("content")
        .and_then(|c| c.get("parts"))
        .and_then(|p| p.as_array());
    let mut out: Vec<String> = Vec::new();
    if let Some(parts) = parts {
        for part in parts {
            if let Some(s) = part.as_str() {
                out.push(s.to_string());
            } else if let Some(s) = part.get("text").and_then(|t| t.as_str()) {
                out.push(s.to_string());
            }
        }
    }
    clean_text(&out.join("\n"))
}

fn load_conversations(path: &Path) -> Result<Vec<serde_json::Value>, Error> {
    if path.is_file()
        && path
            .extension()
            .map(|e| e.eq_ignore_ascii_case("zip"))
            .unwrap_or(false)
    {
        let tmp = tempdir_extract(path)?;
        return load_conversations(tmp.path());
    }
    if path.is_dir() {
        let direct = path.join("conversations.json");
        if direct.exists() {
            return load_conversations(&direct);
        }
        if let Some(found) = find_conversations_json(path) {
            return load_conversations(&found);
        }
        return Err(format!("no conversations.json found under {}", path.display()).into());
    }
    let data: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path)?)?;
    match data {
        serde_json::Value::Array(a) => Ok(a),
        _ => Err("ChatGPT conversations export must be a JSON list".into()),
    }
}

fn find_conversations_json(root: &Path) -> Option<PathBuf> {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir).ok()?;
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
            } else if p
                .file_name()
                .map(|n| n == "conversations.json")
                .unwrap_or(false)
            {
                return Some(p);
            }
        }
    }
    None
}

struct TempDir {
    path: PathBuf,
}
impl TempDir {
    fn path(&self) -> &Path {
        &self.path
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn tempdir_extract(zip_path: &Path) -> Result<TempDir, Error> {
    let base = std::env::temp_dir().join(format!("chorum-chatgpt-{}", std::process::id()));
    std::fs::create_dir_all(&base)?;
    let file = std::fs::File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        let Some(name) = entry.enclosed_name() else {
            continue;
        };
        let out = base.join(name);
        if entry.is_dir() {
            std::fs::create_dir_all(&out)?;
        } else {
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut buf = Vec::new();
            entry.read_to_end(&mut buf)?;
            std::fs::write(&out, buf)?;
        }
    }
    Ok(TempDir { path: base })
}

fn iter_chunks(conversations: &[serde_json::Value], include_assistant: bool) -> Vec<Chunk> {
    let allowed: HashSet<&str> = if include_assistant {
        ["user", "assistant", "tool"].into_iter().collect()
    } else {
        ["user", "tool"].into_iter().collect()
    };
    let mut chunks = Vec::new();
    for (idx, conv) in conversations.iter().enumerate() {
        let conv_id = conv
            .get("id")
            .and_then(|v| v.as_str())
            .map(String::from)
            .unwrap_or_else(|| idx.to_string());
        let title = clean_title(
            conv.get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("Untitled ChatGPT chat"),
        );
        let Some(mapping) = conv.get("mapping").and_then(|m| m.as_object()) else {
            continue;
        };

        let mut messages: Vec<(f64, &serde_json::Value)> = Vec::new();
        for node in mapping.values() {
            if let Some(msg) = node.get("message") {
                if msg.is_object() {
                    let created = msg
                        .get("create_time")
                        .and_then(|v| v.as_f64())
                        .unwrap_or(0.0);
                    messages.push((created, msg));
                }
            }
        }
        messages.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

        for (_, msg) in messages {
            let role = msg
                .get("author")
                .and_then(|a| a.get("role"))
                .and_then(|r| r.as_str())
                .unwrap_or("")
                .to_lowercase();
            if !allowed.contains(role.as_str()) {
                continue;
            }
            let text = message_text(msg);
            if text.is_empty() {
                continue;
            }
            for part in chunk_text(&text, 900) {
                chunks.push(Chunk {
                    title: title.clone(),
                    role: role.clone(),
                    text: part,
                    conversation_id: conv_id.clone(),
                    created_at: msg.get("create_time").and_then(|v| v.as_f64()),
                });
            }
        }
    }
    chunks
}

fn init_db(conn: &Connection) -> Result<(), Error> {
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         CREATE TABLE IF NOT EXISTS chunks (
            id INTEGER PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            title TEXT NOT NULL,
            role TEXT NOT NULL,
            created_at REAL,
            text TEXT NOT NULL
         );
         CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
            USING fts5(title, text, content='chunks', content_rowid='id');",
    )?;
    Ok(())
}

/// Import a ChatGPT data export into a local SQLite FTS database.
pub fn import_chatgpt_export(
    export_path: &Path,
    db_path: &Path,
    include_assistant: bool,
) -> Result<ImportStats, Error> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let conversations = load_conversations(export_path)?;
    let chunks = iter_chunks(&conversations, include_assistant);

    let mut conn = Connection::open(db_path)?;
    init_db(&conn)?;
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM chunks", [])?;
    tx.execute("DELETE FROM chunks_fts", [])?;
    for chunk in &chunks {
        tx.execute(
            "INSERT INTO chunks(conversation_id, title, role, created_at, text) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![chunk.conversation_id, chunk.title, chunk.role, chunk.created_at, chunk.text],
        )?;
        let rowid = tx.last_insert_rowid();
        tx.execute(
            "INSERT INTO chunks_fts(rowid, title, text) VALUES (?1, ?2, ?3)",
            rusqlite::params![rowid, chunk.title, chunk.text],
        )?;
    }
    tx.commit()?;

    Ok(ImportStats {
        conversations: conversations.len(),
        chunks: chunks.len(),
        db_path: db_path.to_path_buf(),
    })
}

fn query_terms(topic: Option<&str>, text: &str) -> Vec<String> {
    let stop: HashSet<&str> = [
        "about", "after", "before", "does", "have", "should", "that", "this", "what", "when",
        "where", "which", "with", "would", "your",
    ]
    .into_iter()
    .collect();
    let combined = format!("{} {}", topic.unwrap_or(""), text).to_lowercase();
    let mut out: Vec<String> = Vec::new();
    for m in token_re().find_iter(&combined) {
        let tok = m.as_str().to_string();
        if stop.contains(tok.as_str()) || out.contains(&tok) {
            continue;
        }
        out.push(tok);
        if out.len() >= 12 {
            break;
        }
    }
    out
}

fn escape_fts_term(term: &str) -> String {
    format!("\"{}\"", term.replace('"', "\"\""))
}

fn search(conn: &Connection, terms: &[String], limit: i64) -> Vec<(String, String, String)> {
    let match_expr = terms
        .iter()
        .take(8)
        .map(|t| escape_fts_term(t))
        .collect::<Vec<_>>()
        .join(" OR ");
    let fts = conn
        .prepare(
            "SELECT chunks.title, chunks.role, chunks.text FROM chunks_fts \
             JOIN chunks ON chunks.id = chunks_fts.rowid \
             WHERE chunks_fts MATCH ?1 ORDER BY bm25(chunks_fts) LIMIT ?2",
        )
        .and_then(|mut stmt| {
            stmt.query_map(rusqlite::params![match_expr, limit], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map(|rows| rows.filter_map(|x| x.ok()).collect::<Vec<_>>())
        });
    if let Ok(rows) = fts {
        return rows;
    }
    // Fallback: LIKE over the first few terms (FTS unavailable / malformed match).
    let like_terms: Vec<String> = terms.iter().take(4).map(|t| format!("%{t}%")).collect();
    if like_terms.is_empty() {
        return Vec::new();
    }
    let clauses = vec!["text LIKE ?"; like_terms.len()].join(" OR ");
    let sql = format!("SELECT title, role, text FROM chunks WHERE {clauses} LIMIT ?");
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    for t in &like_terms {
        params.push(Box::new(t.clone()));
    }
    params.push(Box::new(limit));
    let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|b| b.as_ref()).collect();
    match conn.prepare(&sql) {
        Ok(mut stmt) => stmt
            .query_map(param_refs.as_slice(), |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map(|rows| rows.filter_map(|x| x.ok()).collect())
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

fn best_window(text: &str, terms: &[String], max_chars: usize) -> String {
    let clean = clean_text(text);
    let lowered = clean.to_lowercase();
    let positions: Vec<usize> = terms
        .iter()
        .filter_map(|t| lowered.find(&t.to_lowercase()))
        .collect();
    if positions.is_empty() {
        return truncate(&clean, max_chars);
    }
    let start = positions
        .iter()
        .min()
        .copied()
        .unwrap_or(0)
        .saturating_sub(60);
    // Work on byte offsets carefully: clamp to char boundary.
    let clean_bytes = clean.as_bytes();
    let mut s = start.min(clean_bytes.len());
    while s < clean_bytes.len() && !clean.is_char_boundary(s) {
        s += 1;
    }
    let slice = &clean[s..];
    let window: String = slice.chars().take(max_chars).collect();
    truncate(
        window.trim_matches(|c: char| " ,.;:\n".contains(c)),
        max_chars,
    )
}

fn fact_from_chunk(title: &str, role: &str, text: &str, terms: &[String]) -> Option<String> {
    let snippet = best_window(text, terms, 220);
    if snippet.is_empty() {
        return None;
    }
    let actor = if role == "user" { "user" } else { role };
    Some(format!(
        "Prior ChatGPT chat '{title}' has a {actor} note relevant here: {snippet}"
    ))
}

/// Query the imported memory DB; returns the matching "facts" (snippets).
pub fn query(
    db_path: &Path,
    topic: Option<&str>,
    text: &str,
    limit: i64,
) -> Result<Vec<String>, Error> {
    if !db_path.exists() {
        return Ok(Vec::new());
    }
    let terms = query_terms(topic, text);
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    let conn = Connection::open(db_path)?;
    let rows = search(&conn, &terms, (limit * 3).max(limit));

    let mut facts: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for (title, role, text) in rows {
        let Some(fact) = fact_from_chunk(&title, &role, &text, &terms) else {
            continue;
        };
        let key = fact.to_lowercase();
        if seen.contains(&key) {
            continue;
        }
        seen.insert(key);
        facts.push(fact);
        if facts.len() as i64 >= limit {
            break;
        }
    }
    Ok(facts)
}
