//! Policy gate (ARCHITECTURE.md §7.2).
//!
//! Pure decision function over the user's declared topic policy + ledger stats.
//! Per §1.7 it MUST NOT branch on whether a question is a honeypot — it only
//! consults the topic tag and ledger counts, never the question text.

use std::collections::HashSet;
use std::path::Path;

use crate::models::Question;

/// Curated low-stakes "light topics" answered unattended by default even when
/// the global `auto_answer` opt-in is off, so a freshly-onboarded agent
/// participates out of the box. Anything political/medical/financial/religious
/// is deliberately absent and still requires `auto_answer: true`.
const DEFAULT_AUTO_ANSWER_TOPICS: &[&str] = &[
    // AI / agents
    "ai",
    "agent",
    "agents",
    "llm",
    "llms",
    "ml",
    "genai",
    // software / IT
    "it",
    "tech",
    "technology",
    "software",
    "hardware",
    "programming",
    "coding",
    "code",
    "dev",
    "developer",
    "devops",
    "computers",
    "computer",
    "internet",
    "web",
    "gadgets",
    "opensource",
    // hobbies / lifestyle / entertainment
    "hobby",
    "hobbies",
    "gaming",
    "games",
    "game",
    "music",
    "movies",
    "movie",
    "film",
    "films",
    "tv",
    "books",
    "reading",
    "food",
    "cooking",
    "travel",
    "sports",
    "sport",
    "fitness",
    "photography",
    "art",
    "design",
    "science",
    "space",
    "productivity",
];

fn default_topics() -> HashSet<String> {
    DEFAULT_AUTO_ANSWER_TOPICS
        .iter()
        .map(|s| s.to_string())
        .collect()
}

/// Word-token match (not substring): "ai agents" matches `ai`, "fair" does not.
/// An empty topic never matches.
fn is_light_topic(topic: &str, keywords: &HashSet<String>) -> bool {
    if topic.is_empty() || keywords.is_empty() {
        return false;
    }
    topic
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|t| !t.is_empty())
        .any(|tok| keywords.contains(tok))
}

#[derive(Debug, Clone)]
pub struct LedgerStats {
    pub answered_today: i64,
    pub has_active_delegation: bool,
    pub already_answered_ids: HashSet<String>,
}

#[derive(Debug, Clone)]
pub struct UserPolicy {
    pub topic_allowlist: HashSet<String>,
    pub topic_blocklist: HashSet<String>,
    pub max_answers_per_day: i64,
    pub auto_answer: bool,
    pub auto_answer_topics: HashSet<String>,
}

impl Default for UserPolicy {
    fn default() -> Self {
        Self {
            topic_allowlist: HashSet::new(),
            topic_blocklist: HashSet::new(),
            max_answers_per_day: 50,
            auto_answer: false,
            auto_answer_topics: default_topics(),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    Answer,
    Decline,
    PromptUser,
}

#[derive(Debug)]
pub struct Decision {
    pub action: Action,
    pub reason: String,
}

impl Decision {
    fn answer(reason: impl Into<String>) -> Self {
        Self {
            action: Action::Answer,
            reason: reason.into(),
        }
    }
    fn decline(reason: impl Into<String>) -> Self {
        Self {
            action: Action::Decline,
            reason: reason.into(),
        }
    }
}

fn yaml_str_set(v: Option<&serde_yaml::Value>) -> HashSet<String> {
    match v.and_then(|x| x.as_sequence()) {
        Some(seq) => seq
            .iter()
            .filter_map(|x| x.as_str().map(|s| s.to_string()))
            .collect(),
        None => HashSet::new(),
    }
}

/// Parse the YAML policy from disk. Missing file → curated default.
pub fn load_policy(path: &Path) -> UserPolicy {
    let Ok(text) = std::fs::read_to_string(path) else {
        return UserPolicy::default();
    };
    let raw: serde_yaml::Value = match serde_yaml::from_str(&text) {
        Ok(v) => v,
        Err(_) => return UserPolicy::default(),
    };
    let get = |k: &str| raw.get(k);

    // Absent key → curated default; present (incl. empty list) → honour it, so a
    // user can broaden, narrow, or disable (`auto_answer_topics: []`) the set.
    let auto_answer_topics = match get("auto_answer_topics") {
        None | Some(serde_yaml::Value::Null) => default_topics(),
        Some(seq) => seq
            .as_sequence()
            .map(|s| {
                s.iter()
                    .filter_map(|x| x.as_str().map(|t| t.to_lowercase().trim().to_string()))
                    .collect()
            })
            .unwrap_or_default(),
    };

    UserPolicy {
        topic_allowlist: yaml_str_set(get("topic_allowlist")),
        topic_blocklist: yaml_str_set(get("topic_blocklist")),
        max_answers_per_day: get("max_answers_per_day")
            .and_then(|v| v.as_i64())
            .unwrap_or(50),
        auto_answer: get("auto_answer")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        auto_answer_topics,
    }
}

/// Pure decision function (§7.2). Does NOT inspect `question.text` (§1.7).
pub fn decide(question: &Question, policy: &UserPolicy, stats: &LedgerStats) -> Decision {
    if !stats.has_active_delegation {
        return Decision::decline("no active delegation token");
    }
    if stats.already_answered_ids.contains(&question.question_id) {
        return Decision::decline("already answered");
    }
    if stats.answered_today >= policy.max_answers_per_day {
        return Decision::decline("daily cap reached");
    }

    let topic = question
        .topic
        .clone()
        .unwrap_or_default()
        .to_lowercase()
        .trim()
        .to_string();
    if !topic.is_empty() && policy.topic_blocklist.contains(&topic) {
        return Decision::decline(format!("topic blocked: {topic}"));
    }
    if !policy.topic_allowlist.is_empty() && !policy.topic_allowlist.contains(&topic) {
        let shown = if topic.is_empty() {
            "<none>".to_string()
        } else {
            topic.clone()
        };
        return Decision::decline(format!("topic not in allowlist: {shown}"));
    }

    if policy.auto_answer {
        return Decision::answer("policy match");
    }
    if is_light_topic(&topic, &policy.auto_answer_topics) {
        return Decision::answer(format!("light-topic auto-answer: {topic}"));
    }
    Decision::decline("auto-answer disabled (default)")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(topic: Option<&str>) -> Question {
        Question {
            question_id: "q1".into(),
            text: "t".into(),
            topic: topic.map(|s| s.to_string()),
            options: vec!["yes".into(), "no".into()],
            closes_at: String::new(),
            nonce: "n".into(),
        }
    }

    fn stats() -> LedgerStats {
        LedgerStats {
            answered_today: 0,
            has_active_delegation: true,
            already_answered_ids: HashSet::new(),
        }
    }

    #[test]
    fn light_topic_answers_by_default() {
        let d = decide(&q(Some("AI agents")), &UserPolicy::default(), &stats());
        assert_eq!(d.action, Action::Answer);
    }

    #[test]
    fn non_light_topic_declined_by_default() {
        let d = decide(&q(Some("politics")), &UserPolicy::default(), &stats());
        assert_eq!(d.action, Action::Decline);
    }

    #[test]
    fn substring_does_not_match_word_token() {
        // "fair" must not match "ai".
        let d = decide(&q(Some("fair")), &UserPolicy::default(), &stats());
        assert_eq!(d.action, Action::Decline);
    }

    #[test]
    fn no_delegation_declines() {
        let mut s = stats();
        s.has_active_delegation = false;
        assert_eq!(
            decide(&q(Some("ai")), &UserPolicy::default(), &s).action,
            Action::Decline
        );
    }
}
