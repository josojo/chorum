//! Host-model cost accounting for the answering cron (transparency + budget cap).
//!
//! The chorum addon does no inference of its own — it drives the *host* agent's
//! model, so the API cost it creates is the cost of the Hermes cron sessions it
//! triggers. We don't estimate that: Hermes already prices every session and
//! records it in `state.db`'s `sessions` table (`estimated_cost_usd`,
//! `actual_cost_usd`, token counts, `cost_source`). Because the chorum cron runs
//! ONLY our prompt, each `source='cron'`, `id='cron_<jobid>_*'` row *is* one
//! answering cycle's cost — so we sum exactly those rows, attributed to our job.
//!
//! Two consumers:
//!   * `chorum-skill cost` — prints month-to-date + lifetime spend (transparency).
//!   * the budget guard in [`crate::tools::list_open_questions`] — stops handing
//!     out questions once this month's recorded spend reaches the configured cap.
//!
//! Everything here is READ-ONLY against Hermes' DB and strictly fail-open: any
//! trouble (no state.db, unresolved job id, schema drift) yields an `available:
//! false` report and never blocks answering.

use std::collections::BTreeMap;
use std::path::Path;

use chrono::{DateTime, Utc};
use rusqlite::OpenFlags;
use serde::Serialize;
use serde_json::json;

use crate::config::Settings;
use crate::contracts::JOB_NAME;

/// One priced answering cycle (one Hermes cron session).
#[derive(Debug, Clone, Serialize)]
pub struct RunCost {
    pub session_id: String,
    pub month: String,
    pub model: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_tokens: i64,
    pub cost_usd: f64,
    /// "actual" when the provider returned a real charge, else "estimated".
    pub cost_basis: &'static str,
}

/// Aggregated spend the addon has created on the host's model.
#[derive(Debug, Clone, Serialize)]
pub struct CostReport {
    /// False when we could not read/attribute cost (then everything below is
    /// zero/empty and the budget guard must fail open).
    pub available: bool,
    /// Why `available` is false (for transparency in the CLI / tool output).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    pub monthly_budget_usd: f64,
    pub current_month: String,
    pub current_month_cost_usd: f64,
    pub current_month_runs: u64,
    pub remaining_usd: f64,
    pub over_budget: bool,
    pub lifetime_cost_usd: f64,
    pub lifetime_runs: u64,
    /// Per-month totals (UTC, "YYYY-MM" → USD), oldest key first.
    pub by_month: BTreeMap<String, f64>,
    /// True if any included session carried a real provider charge.
    pub has_actual_cost: bool,
    pub generated_at: String,
}

impl CostReport {
    fn unavailable(settings: &Settings, reason: impl Into<String>) -> Self {
        let budget = settings.monthly_budget_usd;
        CostReport {
            available: false,
            reason: Some(reason.into()),
            job_id: None,
            monthly_budget_usd: budget,
            current_month: current_month(),
            current_month_cost_usd: 0.0,
            current_month_runs: 0,
            remaining_usd: budget,
            over_budget: false, // fail open: never block when we can't measure
            lifetime_cost_usd: 0.0,
            lifetime_runs: 0,
            by_month: BTreeMap::new(),
            has_actual_cost: false,
            generated_at: Utc::now().to_rfc3339(),
        }
    }
}

fn current_month() -> String {
    Utc::now().format("%Y-%m").to_string()
}

/// Resolve the chorum cron job's id by name from Hermes' `cron/jobs.json`.
/// Precise attribution depends on this — we never fall back to "all cron jobs",
/// since that would count an unrelated job's spend against the chorum budget.
fn resolve_job_id(jobs_path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(jobs_path).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let jobs = parsed.get("jobs")?.as_array()?;
    jobs.iter()
        .find(|j| j.get("name").and_then(|n| n.as_str()) == Some(JOB_NAME))
        .and_then(|j| j.get("id").and_then(|i| i.as_str()))
        .map(|s| s.to_string())
}

fn month_of(started_at: f64) -> Option<String> {
    DateTime::<Utc>::from_timestamp(started_at as i64, 0).map(|dt| dt.format("%Y-%m").to_string())
}

/// Build the full cost report for the current profile. Always returns a report;
/// inspect `.available` before trusting the numbers.
pub fn report(settings: &Settings) -> CostReport {
    let Some(state_db) = settings.hermes_state_db_path() else {
        return CostReport::unavailable(settings, "no Hermes home (non-standard root layout)");
    };
    if !state_db.exists() {
        return CostReport::unavailable(
            settings,
            format!("Hermes usage DB not found at {}", state_db.display()),
        );
    }
    let Some(jobs_path) = settings.hermes_cron_jobs_path() else {
        return CostReport::unavailable(settings, "no Hermes home for cron registry");
    };
    let Some(job_id) = resolve_job_id(&jobs_path) else {
        return CostReport::unavailable(
            settings,
            format!(
                "could not resolve cron job '{JOB_NAME}' in {}",
                jobs_path.display()
            ),
        );
    };

    match collect_runs(&state_db, &job_id) {
        Ok(runs) => finish(settings, job_id, runs, &current_month()),
        Err(e) => CostReport::unavailable(settings, format!("reading {}: {e}", state_db.display())),
    }
}

/// Read (read-only) the priced cron sessions for `job_id` from `state_db`.
fn collect_runs(state_db: &Path, job_id: &str) -> Result<Vec<RunCost>, rusqlite::Error> {
    // READ-ONLY so we never lock or mutate Hermes' live DB, and never create it.
    let conn = rusqlite::Connection::open_with_flags(state_db, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let like = format!("cron_{job_id}_%");
    let mut stmt = conn.prepare(
        "SELECT id, started_at, model, \
                COALESCE(input_tokens,0), COALESCE(output_tokens,0), COALESCE(reasoning_tokens,0), \
                estimated_cost_usd, actual_cost_usd \
         FROM sessions WHERE source = 'cron' AND id LIKE ?1 ORDER BY started_at",
    )?;
    let rows = stmt.query_map([&like], |r| {
        let started_at: f64 = r.get(1)?;
        let estimated: Option<f64> = r.get(6)?;
        let actual: Option<f64> = r.get(7)?;
        let (cost, basis) = match actual {
            Some(a) => (a, "actual"),
            None => (estimated.unwrap_or(0.0), "estimated"),
        };
        Ok(RunCost {
            session_id: r.get(0)?,
            month: month_of(started_at).unwrap_or_else(|| "????-??".to_string()),
            model: r.get(2)?,
            input_tokens: r.get(3)?,
            output_tokens: r.get(4)?,
            reasoning_tokens: r.get(5)?,
            cost_usd: cost,
            cost_basis: basis,
        })
    })?;
    rows.collect()
}

fn finish(settings: &Settings, job_id: String, runs: Vec<RunCost>, this_month: &str) -> CostReport {
    let budget = settings.monthly_budget_usd;
    let mut by_month: BTreeMap<String, f64> = BTreeMap::new();
    let mut lifetime = 0.0;
    let mut month_cost = 0.0;
    let mut month_runs = 0u64;
    let mut has_actual = false;
    for run in &runs {
        *by_month.entry(run.month.clone()).or_insert(0.0) += run.cost_usd;
        lifetime += run.cost_usd;
        if run.cost_basis == "actual" {
            has_actual = true;
        }
        if run.month == this_month {
            month_cost += run.cost_usd;
            month_runs += 1;
        }
    }
    CostReport {
        available: true,
        reason: None,
        job_id: Some(job_id),
        monthly_budget_usd: budget,
        current_month: this_month.to_string(),
        current_month_cost_usd: round_usd(month_cost),
        current_month_runs: month_runs,
        remaining_usd: round_usd((budget - month_cost).max(0.0)),
        over_budget: month_cost >= budget,
        lifetime_cost_usd: round_usd(lifetime),
        lifetime_runs: runs.len() as u64,
        by_month: by_month
            .into_iter()
            .map(|(k, v)| (k, round_usd(v)))
            .collect(),
        has_actual_cost: has_actual,
        generated_at: Utc::now().to_rfc3339(),
    }
}

/// Round to a sane USD precision for display/storage (6 dp ≈ sub-cent fidelity).
fn round_usd(v: f64) -> f64 {
    (v * 1_000_000.0).round() / 1_000_000.0
}

/// Persist a small rollup snapshot to `<root>/cost.json` for durable
/// transparency. Best-effort: failures are ignored (it's a convenience record,
/// not a source of truth — Hermes' DB is).
pub fn write_snapshot(settings: &Settings, report: &CostReport) {
    if !report.available {
        return;
    }
    let snapshot = json!({
        "updated_at": report.generated_at,
        "monthly_budget_usd": report.monthly_budget_usd,
        "current_month": report.current_month,
        "current_month_cost_usd": report.current_month_cost_usd,
        "current_month_runs": report.current_month_runs,
        "remaining_usd": report.remaining_usd,
        "over_budget": report.over_budget,
        "lifetime_cost_usd": report.lifetime_cost_usd,
        "lifetime_runs": report.lifetime_runs,
        "by_month": report.by_month,
        "cost_basis": if report.has_actual_cost { "actual+estimated" } else { "estimated" },
        "note": "Host-model API spend created by the chorum answering cron, read from Hermes' per-session usage DB.",
    });
    if let Ok(body) = serde_json::to_string_pretty(&snapshot) {
        let _ = std::fs::write(settings.cost_snapshot_path(), body);
    }
}

/// Cost guard for the answering path. Computes this month's spend, refreshes the
/// snapshot, and returns the report so the caller can decide whether to skip.
/// Fail-open: an unavailable report has `over_budget == false`.
pub fn guard(settings: &Settings) -> CostReport {
    let report = report(settings);
    write_snapshot(settings, &report);
    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn settings_with(root: &Path, budget: f64) -> Settings {
        let mut s = Settings::defaults();
        s.root_dir = root.join("chorum");
        s.monthly_budget_usd = budget;
        s
    }

    /// Stand up a fake Hermes home: state.db with a sessions table + cron/jobs.json.
    fn fake_home(dir: &Path, job_id: &str) {
        std::fs::create_dir_all(dir.join("chorum")).unwrap();
        std::fs::create_dir_all(dir.join("cron")).unwrap();
        std::fs::write(
            dir.join("cron").join("jobs.json"),
            json!({"jobs": [{"id": job_id, "name": JOB_NAME}]}).to_string(),
        )
        .unwrap();
        let conn = Connection::open(dir.join("state.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE sessions (
                id TEXT PRIMARY KEY, source TEXT, model TEXT, started_at REAL,
                input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
                estimated_cost_usd REAL, actual_cost_usd REAL);",
        )
        .unwrap();
    }

    fn insert(dir: &Path, id: &str, started_at: f64, est: Option<f64>, act: Option<f64>) {
        let conn = Connection::open(dir.join("state.db")).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, source, model, started_at, input_tokens, output_tokens, reasoning_tokens, estimated_cost_usd, actual_cost_usd) \
             VALUES (?1, 'cron', 'test-model', ?2, 100, 10, 0, ?3, ?4)",
            rusqlite::params![id, started_at, est, act],
        )
        .unwrap();
    }

    // 2026-06-15T00:00:00Z and 2026-05-10T00:00:00Z as epoch seconds.
    const JUN_2026: f64 = 1_781_136_000.0;
    const MAY_2026: f64 = 1_778_371_200.0;

    #[test]
    fn sums_only_this_jobs_sessions_by_month() {
        let dir = tempfile::tempdir().unwrap();
        fake_home(dir.path(), "abc123");
        // two June runs for our job, one May run, plus a foreign cron job's run
        insert(dir.path(), "cron_abc123_a", JUN_2026, Some(0.001), None);
        insert(dir.path(), "cron_abc123_b", JUN_2026, Some(0.002), None);
        insert(dir.path(), "cron_abc123_c", MAY_2026, Some(0.005), None);
        insert(dir.path(), "cron_OTHERJOB_x", JUN_2026, Some(9.99), None); // must be excluded

        let s = settings_with(dir.path(), 5.0);
        let runs = collect_runs(&s.hermes_state_db_path().unwrap(), "abc123").unwrap();
        assert_eq!(
            runs.len(),
            3,
            "foreign job's session must not be attributed"
        );
        let rep = finish(&s, "abc123".into(), runs, "2026-06");
        assert!(rep.available);
        assert_eq!(rep.lifetime_runs, 3);
        assert!((rep.lifetime_cost_usd - 0.008).abs() < 1e-9);
        assert_eq!(rep.by_month.get("2026-06").copied(), Some(0.003));
        assert_eq!(rep.by_month.get("2026-05").copied(), Some(0.005));
    }

    #[test]
    fn over_budget_trips_only_for_the_current_month() {
        let dir = tempfile::tempdir().unwrap();
        fake_home(dir.path(), "j");
        // A huge May run must NOT trip June's budget.
        insert(dir.path(), "cron_j_may", MAY_2026, Some(100.0), None);
        let s = settings_with(dir.path(), 5.0);
        let runs = collect_runs(&s.hermes_state_db_path().unwrap(), "j").unwrap();
        // Evaluate "as if" the current month is June: May's spend must not count.
        let rep = finish(&s, "j".into(), runs, "2026-06");
        assert!(
            !rep.over_budget,
            "prior month's spend must not block this month"
        );
        assert_eq!(rep.remaining_usd, 5.0);
        // And in May itself, the same data DOES trip the budget.
        let runs2 = collect_runs(&s.hermes_state_db_path().unwrap(), "j").unwrap();
        assert!(finish(&s, "j".into(), runs2, "2026-05").over_budget);
    }

    #[test]
    fn prefers_actual_charge_over_estimate() {
        let dir = tempfile::tempdir().unwrap();
        fake_home(dir.path(), "j");
        insert(dir.path(), "cron_j_1", JUN_2026, Some(0.01), Some(0.02));
        let s = settings_with(dir.path(), 5.0);
        let runs = collect_runs(&s.hermes_state_db_path().unwrap(), "j").unwrap();
        assert_eq!(runs[0].cost_usd, 0.02);
        assert_eq!(runs[0].cost_basis, "actual");
        assert!(finish(&s, "j".into(), runs, "2026-06").has_actual_cost);
    }

    #[test]
    fn unavailable_when_no_state_db_and_fails_open() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("chorum")).unwrap();
        let s = settings_with(dir.path(), 5.0);
        let rep = report(&s);
        assert!(!rep.available);
        assert!(!rep.over_budget, "must fail open when cost can't be read");
    }

    #[test]
    fn unavailable_when_job_id_unresolved() {
        let dir = tempfile::tempdir().unwrap();
        fake_home(dir.path(), "j");
        // Overwrite jobs.json with a different job name → our job is absent.
        std::fs::write(
            dir.path().join("cron").join("jobs.json"),
            json!({"jobs": [{"id": "x", "name": "some-other-job"}]}).to_string(),
        )
        .unwrap();
        let s = settings_with(dir.path(), 5.0);
        let rep = report(&s);
        assert!(!rep.available);
        assert!(rep.reason.unwrap().contains(JOB_NAME));
    }
}
