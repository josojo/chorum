//! Framework-agnostic answering tools — the reusable core.
//!
//! Plain synchronous functions with no host-framework deps; the SAME core backs
//! the Hermes subprocess shim and the OpenClaw SKILL.md (both shell out to the
//! `hearme-skill` binary). Each returns a JSON-friendly value and never panics —
//! failures come back as structured results the agent can read.
//!
//! Privacy invariants are enforced HERE, not in a prompt: the DelegationToken
//! and signing nonce never leave this crate, and the policy gate is re-checked
//! on every submit.

use serde_json::{json, Value};

use crate::broker;
use crate::config::Settings;
use crate::crypto::load_or_create_agent_keypair;
use crate::delegation::{hash_of, load_usable, DelegationError};
use crate::envelope::{build_envelope, build_no_signal_envelope, build_revocation};
use crate::ledger::Ledger;
use crate::policy::{decide, load_policy, Action, LedgerStats};
use crate::Error;

/// Match a free-form agent answer to exactly one of the question's options.
///
/// Strict, privacy-preserving normalisation: the answer must BEGIN with one of
/// the options (case-insensitive), with the match ending on a word boundary
/// (end-of-string or a non-alphanumeric char) so `"no"` cannot swallow a match
/// for `"none of the above"`. Returns the question's CANONICAL option string —
/// any trailing free text the agent appended is discarded, so nothing beyond
/// the chosen option label is ever signed or sent on the wire. Prefers the
/// longest matching option so multi-word options win over their prefixes.
fn match_option<'a>(answer: &str, options: &'a [String]) -> Option<&'a str> {
    let lower = answer.to_lowercase();
    let mut best: Option<&'a str> = None;
    for opt in options {
        let opt_lower = opt.trim().to_lowercase();
        if opt_lower.is_empty() || !lower.starts_with(&opt_lower) {
            continue;
        }
        // `lower` starts with `opt_lower`, so this byte index is a char
        // boundary; the next char (if any) must be a non-alphanumeric separator.
        let boundary = match lower[opt_lower.len()..].chars().next() {
            None => true,
            Some(c) => !c.is_alphanumeric(),
        };
        if boundary && best.map_or(true, |b| opt.len() > b.len()) {
            best = Some(opt.as_str());
        }
    }
    best
}

fn ledger_stats(ledger: &Ledger, settings: &Settings) -> Result<LedgerStats, Error> {
    Ok(LedgerStats {
        answered_today: ledger.answered_today()?,
        has_active_delegation: settings.delegation_path().exists(),
        already_answered_ids: ledger.already_answered_ids()?,
    })
}

/// Open questions the user's policy permits answering.
/// Shape: `{"questions": [...], "skipped_count": int}`. Never errors out — a
/// broker/ledger failure comes back as `{"error": ...}`.
pub fn list_open_questions(settings: &Settings) -> Value {
    match list_impl(settings) {
        Ok(v) => v,
        Err(e) => json!({ "error": e.to_string(), "questions": [], "skipped_count": 0 }),
    }
}

fn list_impl(settings: &Settings) -> Result<Value, Error> {
    // Cost cap: once this calendar month's recorded host-model spend for the
    // hearme cron reaches the budget, return ZERO questions so the agent does no
    // further (paid) answering and stops immediately. We return the SAME minimal
    // shape as a genuinely empty cycle — no prose, no cost numbers — so the
    // answer prompt's "no questions -> [SILENT]" path fires with the fewest
    // possible tokens (a budget-reached cycle should be the cheapest run there
    // is). The `budget_reached` flag is a single boolean for transcript
    // debuggability; the actual figures live in cost.json + `hearme-skill cost`.
    // Fail-open: an unmeasurable cost (no Hermes usage DB, unresolved job id)
    // leaves `over_budget` false and never blocks answering. The guard also
    // refreshes the durable cost.json snapshot each cycle.
    let cost = crate::cost::guard(settings);
    if cost.over_budget {
        return Ok(json!({ "questions": [], "skipped_count": 0, "budget_reached": true }));
    }

    let ledger = Ledger::open(&settings.ledger_path())?;
    let policy = load_policy(&settings.policy_path());
    let stats = ledger_stats(&ledger, settings)?;
    let questions = broker::fetch_open_questions(&settings.broker_url)?;

    let mut answerable: Vec<Value> = Vec::new();
    let mut skipped = 0i64;
    for q in &questions {
        if decide(q, &policy, &stats).action == Action::Answer {
            // Deliberately omit the nonce — it is signing material and never
            // needs to enter the agent's (LLM) context.
            answerable.push(json!({
                "question_id": q.question_id,
                "text": q.text,
                "topic": q.topic,
                "options": q.options,
                "closes_at": q.closes_at,
            }));
        } else {
            skipped += 1;
        }
    }
    Ok(json!({ "questions": answerable, "skipped_count": skipped }))
}

/// Sign + submit one answer the agent decided on.
/// Shape: `{"accepted": bool, "reason": str, "question_id": str}`. Enforces the
/// full policy/replay/delegation backstop; never panics.
pub fn submit_answer(question_id: &str, answer_text: &str, settings: &Settings) -> Value {
    match submit_impl(question_id, answer_text, settings) {
        Ok(v) => v,
        Err(e) => json!({ "accepted": false, "reason": e.to_string(), "question_id": question_id }),
    }
}

fn submit_impl(question_id: &str, answer_text: &str, settings: &Settings) -> Result<Value, Error> {
    let answer_text = answer_text.trim();
    if answer_text.is_empty() {
        return Ok(
            json!({ "accepted": false, "reason": "empty-answer", "question_id": question_id }),
        );
    }

    let ledger = Ledger::open(&settings.ledger_path())?;
    // §1.9 replay-safety.
    if ledger.has_submission(question_id)? {
        return Ok(
            json!({ "accepted": false, "reason": "already-submitted", "question_id": question_id }),
        );
    }

    // Delegation must be loadable + unexpired BEFORE we sign anything.
    let token = match load_usable(&settings.delegation_path()) {
        Ok(t) => t,
        Err(DelegationError::Missing) => {
            return Ok(
                json!({ "accepted": false, "reason": "no-delegation", "question_id": question_id }),
            )
        }
        Err(DelegationError::Expired) => {
            return Ok(
                json!({ "accepted": false, "reason": "delegation-expired", "question_id": question_id }),
            )
        }
        Err(e) => return Err(Box::new(e)),
    };

    // Re-fetch so we read the authoritative nonce + confirm still-open.
    let questions = broker::fetch_open_questions(&settings.broker_url)?;
    let question = match questions.into_iter().find(|q| q.question_id == question_id) {
        Some(q) => q,
        None => {
            return Ok(
                json!({ "accepted": false, "reason": "question-not-open", "question_id": question_id }),
            )
        }
    };

    // Privacy backstop: constrain the answer to exactly one of the question's
    // options. Enforced HERE, not in a prompt — a jailbroken/injected agent
    // cannot smuggle extra text past this point. We sign and send only the
    // canonical option label; any reasoning the agent appended is dropped.
    let canonical = match match_option(answer_text, &question.options) {
        Some(opt) => opt.to_string(),
        None => {
            return Ok(json!({
                "accepted": false,
                "reason": "not-an-option",
                "question_id": question_id,
            }));
        }
    };

    // Hard policy backstop, re-evaluated at submit time.
    let policy = load_policy(&settings.policy_path());
    let stats = LedgerStats {
        has_active_delegation: true,
        ..ledger_stats(&ledger, settings)?
    };
    let decision = decide(&question, &policy, &stats);
    if decision.action != Action::Answer {
        return Ok(json!({
            "accepted": false,
            "reason": format!("policy-declined:{}", decision.reason),
            "question_id": question_id,
        }));
    }

    ledger.record_question(
        &question.question_id,
        &question.text,
        question.topic.as_deref(),
        &question.closes_at,
        &question.nonce,
    )?;

    let agent_kp = load_or_create_agent_keypair(&settings.agent_key_path())?;
    let envelope = build_envelope(
        &question.question_id,
        &canonical,
        &question.nonce,
        &token,
        &agent_kp,
    );
    let agent_signature = envelope
        .get("agent_signature")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    let (accepted, reason) = broker::submit_envelope(&settings.broker_url, &envelope)?;

    // rationale stays empty — the agent's reasoning never enters the ledger/wire.
    ledger.record_answer(question_id, &canonical, "")?;
    ledger.record_submission(
        question_id,
        &hash_of(&token),
        &agent_signature,
        accepted,
        if reason.is_empty() {
            None
        } else {
            Some(reason.as_str())
        },
    )?;

    let reason_out = if !reason.is_empty() {
        reason
    } else if accepted {
        "ok".to_string()
    } else {
        "rejected".to_string()
    };
    Ok(json!({ "accepted": accepted, "reason": reason_out, "question_id": question_id }))
}

/// Record that the user has NO formed view on one question (§1.14).
/// Shape: `{"accepted": bool, "reason": str, "question_id": str}`. Submits a
/// no-signal envelope (empty answer, `no_signal: true`) so "no opinion" becomes
/// real aggregate data rather than silence. Same delegation/replay/policy
/// backstop as `submit_answer`; never panics.
pub fn submit_no_signal(question_id: &str, settings: &Settings) -> Value {
    match submit_no_signal_impl(question_id, settings) {
        Ok(v) => v,
        Err(e) => json!({ "accepted": false, "reason": e.to_string(), "question_id": question_id }),
    }
}

fn submit_no_signal_impl(question_id: &str, settings: &Settings) -> Result<Value, Error> {
    let ledger = Ledger::open(&settings.ledger_path())?;
    // §1.9 replay-safety: one envelope per question, no_signal or not.
    if ledger.has_submission(question_id)? {
        return Ok(
            json!({ "accepted": false, "reason": "already-submitted", "question_id": question_id }),
        );
    }

    let token = match load_usable(&settings.delegation_path()) {
        Ok(t) => t,
        Err(DelegationError::Missing) => {
            return Ok(
                json!({ "accepted": false, "reason": "no-delegation", "question_id": question_id }),
            )
        }
        Err(DelegationError::Expired) => {
            return Ok(
                json!({ "accepted": false, "reason": "delegation-expired", "question_id": question_id }),
            )
        }
        Err(e) => return Err(Box::new(e)),
    };

    // Re-fetch so we read the authoritative nonce + confirm still-open.
    let questions = broker::fetch_open_questions(&settings.broker_url)?;
    let question = match questions.into_iter().find(|q| q.question_id == question_id) {
        Some(q) => q,
        None => {
            return Ok(
                json!({ "accepted": false, "reason": "question-not-open", "question_id": question_id }),
            )
        }
    };

    // Policy still applies: recording "no opinion" is participating, so a
    // blocked topic or an exhausted daily cap declines here too (§7.2). No
    // option matching — a no-signal envelope carries no answer.
    let policy = load_policy(&settings.policy_path());
    let stats = LedgerStats {
        has_active_delegation: true,
        ..ledger_stats(&ledger, settings)?
    };
    let decision = decide(&question, &policy, &stats);
    if decision.action != Action::Answer {
        return Ok(json!({
            "accepted": false,
            "reason": format!("policy-declined:{}", decision.reason),
            "question_id": question_id,
        }));
    }

    ledger.record_question(
        &question.question_id,
        &question.text,
        question.topic.as_deref(),
        &question.closes_at,
        &question.nonce,
    )?;

    let agent_kp = load_or_create_agent_keypair(&settings.agent_key_path())?;
    let envelope =
        build_no_signal_envelope(&question.question_id, &question.nonce, &token, &agent_kp);
    let agent_signature = envelope
        .get("agent_signature")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    let (accepted, reason) = broker::submit_envelope(&settings.broker_url, &envelope)?;

    // Empty answer text records the no-signal outcome in the local ledger.
    ledger.record_answer(question_id, "", "")?;
    ledger.record_submission(
        question_id,
        &hash_of(&token),
        &agent_signature,
        accepted,
        if reason.is_empty() {
            None
        } else {
            Some(reason.as_str())
        },
    )?;

    let reason_out = if !reason.is_empty() {
        reason
    } else if accepted {
        "ok".to_string()
    } else {
        "rejected".to_string()
    };
    Ok(json!({ "accepted": accepted, "reason": reason_out, "question_id": question_id }))
}

/// The user's own recently submitted answers (local-only read).
pub fn review_my_answers(limit: i64, settings: &Settings) -> Value {
    match review_impl(limit, settings) {
        Ok(v) => v,
        Err(e) => json!({ "error": e.to_string(), "answers": [] }),
    }
}

fn review_impl(limit: i64, settings: &Settings) -> Result<Value, Error> {
    let ledger = Ledger::open(&settings.ledger_path())?;
    let subs = ledger.list_recent_submissions(limit)?;
    let mut out: Vec<Value> = Vec::new();
    for s in subs {
        let meta = ledger.question_meta(&s.question_id)?;
        let (qtext, topic, closes_at) = match meta {
            Some((t, top, c)) => (Some(t), top, Some(c)),
            None => (None, None, None),
        };
        out.push(json!({
            "question_id": s.question_id,
            "question_text": qtext,
            "topic": topic,
            "closes_at": closes_at,
            "answer_text": ledger.answer_text(&s.question_id)?,
            "submitted_at": s.submitted_at,
            "accepted": s.accepted,
            "reason": s.reason,
        }));
    }
    Ok(json!({ "answers": out }))
}

/// Retract one of the user's previously-submitted answers (§1.12).
pub fn revoke_answer(question_id: &str, settings: &Settings) -> Value {
    match revoke_impl(question_id, settings) {
        Ok(v) => v,
        Err(e) => json!({ "accepted": false, "reason": e.to_string(), "question_id": question_id }),
    }
}

fn revoke_impl(question_id: &str, settings: &Settings) -> Result<Value, Error> {
    let _ledger = Ledger::open(&settings.ledger_path())?;
    let token = match load_usable(&settings.delegation_path()) {
        Ok(t) => t,
        Err(DelegationError::Missing) => {
            return Ok(
                json!({ "accepted": false, "reason": "no-delegation", "question_id": question_id }),
            )
        }
        Err(DelegationError::Expired) => {
            return Ok(
                json!({ "accepted": false, "reason": "delegation-expired", "question_id": question_id }),
            )
        }
        Err(e) => return Err(Box::new(e)),
    };

    let agent_kp = load_or_create_agent_keypair(&settings.agent_key_path())?;
    let body = build_revocation(question_id, &token, &agent_kp);
    let (accepted, reason) = broker::submit_revocation(&settings.broker_url, &body)?;
    let reason_out = if !reason.is_empty() {
        reason
    } else if accepted {
        "ok".to_string()
    } else {
        "rejected".to_string()
    };
    Ok(json!({ "accepted": accepted, "reason": reason_out, "question_id": question_id }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn exact_option_matches_and_canonicalises_case() {
        let o = opts(&["yes", "no"]);
        assert_eq!(match_option("YES", &o), Some("yes"));
        assert_eq!(match_option("no", &o), Some("no"));
    }

    #[test]
    fn trailing_reasoning_is_dropped_to_the_option() {
        // A leaky answer still resolves to ONLY the canonical option label.
        let o = opts(&["yes", "no"]);
        assert_eq!(
            match_option("yes — she runs prod from the Frankfurt box", &o),
            Some("yes")
        );
    }

    #[test]
    fn prefix_must_end_on_a_word_boundary() {
        // "no" must NOT match "none of the above".
        let o = opts(&["yes", "no"]);
        assert_eq!(match_option("none of the above", &o), None);
    }

    #[test]
    fn prefers_the_longest_matching_option() {
        let o = opts(&["pizza", "pizza margherita"]);
        assert_eq!(
            match_option("pizza margherita please", &o),
            Some("pizza margherita")
        );
    }

    #[test]
    fn no_match_returns_none() {
        let o = opts(&["yes", "no"]);
        assert_eq!(match_option("maybe", &o), None);
        assert_eq!(match_option("", &o), None);
    }

    #[test]
    fn over_budget_returns_zero_questions_without_touching_the_broker() {
        use crate::contracts::JOB_NAME;
        use rusqlite::Connection;

        // Fake Hermes home: <home>/{state.db, cron/jobs.json}; our root is <home>/hearme.
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(home.path().join("hearme")).unwrap();
        std::fs::create_dir_all(home.path().join("cron")).unwrap();
        std::fs::write(
            home.path().join("cron").join("jobs.json"),
            json!({"jobs": [{"id": "job1", "name": JOB_NAME}]}).to_string(),
        )
        .unwrap();
        let conn = Connection::open(home.path().join("state.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, model TEXT, started_at REAL,
                input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
                estimated_cost_usd REAL, actual_cost_usd REAL);",
        )
        .unwrap();
        // A cron session in the CURRENT month whose cost blows past the budget.
        let now = chrono::Utc::now().timestamp() as f64;
        conn.execute(
            "INSERT INTO sessions (id, source, model, started_at, input_tokens, output_tokens, reasoning_tokens, estimated_cost_usd, actual_cost_usd)
             VALUES ('cron_job1_now', 'cron', 'm', ?1, 1, 1, 0, 1.0, NULL)",
            [now],
        )
        .unwrap();

        let mut settings = Settings::defaults();
        settings.root_dir = home.path().join("hearme");
        settings.monthly_budget_usd = 0.5; // recorded $1.00 > $0.50 budget
        // A broker that MUST NOT be contacted — if the guard didn't short-circuit,
        // fetch_open_questions would surface an {"error": ...} instead.
        settings.broker_url = "http://127.0.0.1:1/should-never-be-called".to_string();

        let out = list_open_questions(&settings);
        assert_eq!(out["questions"].as_array().unwrap().len(), 0);
        assert_eq!(out["budget_reached"], json!(true));
        assert!(out.get("error").is_none(), "broker must not be contacted when over budget");
    }
}
