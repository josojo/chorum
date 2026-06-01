//! Behavioural contract shared between the binary and the per-host adapters.
//!
//! The Hermes subprocess shim ([`crate::hermes::build_subprocess_shim`]) bakes
//! these constants in verbatim so the binary and the shim cannot drift; the
//! OpenClaw SKILL.md ([`crate::openclaw`]) mirrors the same answering rules in
//! prose.

/// Hermes toolset name (and the OpenClaw skill name).
pub const TOOLSET: &str = "hearme";

/// Cron job name registered on both hosts.
pub const JOB_NAME: &str = "hearme-answer-cycle";

/// Default cadence: once a day at 09:00 UTC. Questions close on a day scale, so
/// daily keeps host-model cost predictable while staying responsive.
pub const DEFAULT_SCHEDULE: &str = "0 9 * * *";

/// The behavioural contract handed to the Hermes agent each cycle.
pub const ANSWER_PROMPT: &str = "You answer public multiple-choice questions on behalf of your user, in their voice.\n\n1. Call hearme_list_open_questions. Each returned question carries an 'options' array (e.g. ['yes','no'] or ['pizza','pasta','sushi']) — those are the only valid answers.\n2. For each question, decide your user's honest answer based ONLY on what you actually know about them from your memory and past conversations. If you do not genuinely know how they would answer, SKIP it — do not guess or invent a preference.\n3. Write the answer beginning with one of the question's options EXACTLY (case-insensitive), then one short sentence of reasoning in their voice.\n4. Submit each answer with hearme_submit_answer(question_id=..., answer=...).\n\nWhen there are no questions you can confidently answer, stop. Never fabricate views your user does not hold.";

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
    "description": "Submit the user's answer to one Hearme question. The answer must begin with one of the question's options EXACTLY (case-insensitive), followed by one short sentence of reasoning in the user's voice, based only on what you actually know about them. Only call this for questions returned by hearme_list_open_questions. Returns {accepted, reason, question_id}.",
    "parameters": {
        "type": "object",
        "properties": {
            "question_id": {"type": "string", "description": "The question_id from hearme_list_open_questions."},
            "answer": {"type": "string", "description": "The user's answer: start with one of the question's options exactly, then one short sentence."},
        },
        "required": ["question_id", "answer"],
    },
}"#;

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
