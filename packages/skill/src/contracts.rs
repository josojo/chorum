//! Behavioural contract shared between the binary and the per-host adapters.
//!
//! The Hermes subprocess shim ([`crate::hermes::build_subprocess_shim`]) bakes
//! these constants in verbatim so the binary and the shim cannot drift; the
//! OpenClaw SKILL.md ([`crate::openclaw`]) mirrors the same answering rules in
//! prose.

/// Hermes toolset name (and the OpenClaw skill name).
pub const TOOLSET: &str = "hearme";

/// Toolsets the answering cron is granted on Hermes. Beyond `hearme`'s own
/// submit tools the agent needs to *recall the user* before it can answer:
/// `session_search` is the FTS5 RAG over past Hermes conversations in
/// `state.db`, and `memory` exposes the MEMORY.md / USER.md provider tools.
/// With only `[hearme]` the cron agent had no way to reach either store, so it
/// ran blind and returned `[SILENT]` on every question — restricting the cron
/// to `[hearme]` (vs. `None`) also makes Hermes strip the auto-injected memory
/// provider tools (see agent_init's `"memory" in enabled_toolsets` gate).
pub const ANSWER_TOOLSETS: &[&str] = &["hearme", "session_search", "memory"];

/// Cron job name registered on both hosts.
pub const JOB_NAME: &str = "hearme-answer-cycle";

/// Default cadence: once a day at 09:00 UTC. Questions close on a day scale, so
/// daily keeps host-model cost predictable while staying responsive.
pub const DEFAULT_SCHEDULE: &str = "0 9 * * *";

/// The behavioural contract handed to the Hermes agent each cycle.
pub const ANSWER_PROMPT: &str = "You answer public multiple-choice questions on behalf of your user, in their voice.\n\n1. Call hearme_list_open_questions. Each returned question carries an 'options' array (e.g. ['yes','no'] or ['pizza','pasta','sushi']) — those are the only valid answers.\n2. Before deciding, actively RECALL the user. Your injected memory (MEMORY.md / USER.md) holds only a few distilled facts, so do NOT rely on it alone: for each question, call session_search with the question's topic and key terms to pull up what the user has actually said in past conversations. Search again with different phrasings if the first query comes back thin. Base every answer ONLY on evidence you find about THIS user — never on generic assumptions or what a typical person might think.\n3. If the recalled evidence genuinely tells you how they would answer, submit it with hearme_submit_answer(question_id=..., answer=<the option, verbatim>). The answer must be EXACTLY one of the question's options and nothing else — no reasoning, no explanation, no extra words; anything beyond the option label is discarded before submission to protect your user's private context.\n4. If you searched and still do NOT know how your user would answer, do not guess — call hearme_submit_no_signal(question_id=...) instead. 'No formed view' is real, valuable data, not a reason to stay silent. Only leave a question entirely alone when it is off-limits for your user.\n\nNever fabricate views your user does not hold.";

/// OpenAI-style tool schema for `hearme_list_open_questions`, as a Python dict
/// literal (baked into the generated shim).
pub const LIST_SCHEMA_PY: &str = r#"{
    "name": "hearme_list_open_questions",
    "description": "List the open Hearme questions the user's policy permits you to answer on their behalf. Returns {questions: [{question_id, text, topic, options, closes_at}], skipped_count}. Each question's `options` array lists the only allowed answers (e.g. ['yes','no'] or ['pizza','pasta','sushi']). Call this first.",
    "parameters": {"type": "object", "properties": {}, "required": []},
}"#;

/// OpenAI-style tool schema for `hearme_submit_answer`, as a Python dict literal.
pub const SUBMIT_SCHEMA_PY: &str = r#"{
    "name": "hearme_submit_answer",
    "description": "Submit the user's answer to one Hearme question. The answer must be EXACTLY one of the question's options (case-insensitive) and nothing else — any extra text is stripped before submission, and an answer matching no option is rejected with reason 'not-an-option'. Only call this for questions returned by hearme_list_open_questions. Returns {accepted, reason, question_id}.",
    "parameters": {
        "type": "object",
        "properties": {
            "question_id": {"type": "string", "description": "The question_id from hearme_list_open_questions."},
            "answer": {"type": "string", "description": "The user's answer: exactly one of the question's options, verbatim, with no additional text."},
        },
        "required": ["question_id", "answer"],
    },
}"#;

/// OpenAI-style tool schema for `hearme_submit_no_signal`, as a Python dict literal.
pub const SUBMIT_NO_SIGNAL_SCHEMA_PY: &str = r#"{
    "name": "hearme_submit_no_signal",
    "description": "Record that the user has NO formed view on one Hearme question — call this instead of guessing when you do not know how they would answer. It submits a signed 'no opinion' data point (a first-class result, not silence). Only call this for questions returned by hearme_list_open_questions. Returns {accepted, reason, question_id}.",
    "parameters": {
        "type": "object",
        "properties": {
            "question_id": {"type": "string", "description": "The question_id from hearme_list_open_questions."},
        },
        "required": ["question_id"],
    },
}"#;

/// Render [`ANSWER_TOOLSETS`] as a Python list literal (e.g.
/// `["hearme", "session_search", "memory"]`) for baking into the shim's
/// `create_job(enabled_toolsets=...)` call.
pub fn answer_toolsets_py() -> String {
    let items: Vec<String> = ANSWER_TOOLSETS.iter().map(|s| py_str(s)).collect();
    format!("[{}]", items.join(", "))
}

/// Render a Rust string as a Python double-quoted string literal (escaping
/// backslash, double-quote, and the common control chars). Used when baking
/// values into the generated Python shim.
pub fn py_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
