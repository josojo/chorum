//! Command-line interface — the binary's whole surface.
//!
//! Mirrors the original Python `argparse` CLI command-for-command so the
//! generated Hermes shim and the OpenClaw SKILL.md (both of which invoke these
//! subcommands) keep working unchanged. Answering commands print JSON to stdout;
//! their exit code tracks `accepted` where applicable.

use std::io::Read;
use std::path::{Path, PathBuf};

use clap::{Parser, Subcommand, ValueEnum};

use crate::config::{get_settings, Settings};
use crate::{hermes, onboarding, openclaw, tools};

#[derive(Parser)]
#[command(name = "hearme-skill", version, about = "Hearme standalone skill CLI")]
struct Cli {
    /// Target a named Hermes profile (installs under ~/.hermes/profiles/<name>).
    /// Without this, the active $HERMES_HOME is used, else the default ~/.hermes.
    /// Note: distinct from `onboard --profile`, which selects the Self identity tier.
    #[arg(long, global = true)]
    hermes_profile: Option<String>,
    /// Target an explicit Hermes home directory (overrides --hermes-profile and
    /// any inherited $HERMES_HOME). Use when your profile lives off the beaten path.
    #[arg(long, global = true)]
    hermes_home: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Copy, Clone, PartialEq, Eq, ValueEnum)]
enum HostArg {
    Auto,
    Hermes,
    Openclaw,
    Both,
}

impl HostArg {
    fn as_str(self) -> &'static str {
        match self {
            HostArg::Auto => "auto",
            HostArg::Hermes => "hermes",
            HostArg::Openclaw => "openclaw",
            HostArg::Both => "both",
        }
    }
}

#[derive(Subcommand)]
enum Command {
    /// Generate agent key, print the Self QR codes, register, and store the token.
    Onboard {
        #[arg(long)]
        bridge_url: Option<String>,
        #[arg(long)]
        broker_url: Option<String>,
        #[arg(long, default_value = "standard")]
        profile: String,
        /// Seconds to wait for the phone to send a proof.
        #[arg(long, default_value_t = 300.0)]
        timeout: f64,
        /// Print the QR/link and exit without waiting for the proof.
        #[arg(long)]
        no_wait: bool,
        /// Which agent host to wire up after onboarding ('auto' detects).
        #[arg(long, value_enum, default_value_t = HostArg::Auto)]
        host: HostArg,
    },
    /// Accept a DelegationToken JSON (dev fixture replay).
    AcceptMockDelegation {
        /// Path to token JSON, or '-' for stdin.
        token_path: String,
    },
    /// Install/refresh the Hermes cron job (only works inside Hermes).
    Schedule {
        #[arg(long)]
        schedule: Option<String>,
        #[arg(long)]
        model: Option<String>,
        #[arg(long)]
        provider: Option<String>,
    },
    /// Drop the Hermes plugin manifest + shim and restart the gateway.
    InstallPlugin {
        #[arg(long)]
        no_restart: bool,
        #[arg(long)]
        broker_url: Option<String>,
        #[arg(long)]
        bridge_url: Option<String>,
    },
    /// Detect the agent host(s) and install the hearme skill/plugin for each.
    Install {
        #[arg(long, value_enum, default_value_t = HostArg::Auto)]
        host: HostArg,
        #[arg(long)]
        no_restart: bool,
        #[arg(long)]
        no_cron: bool,
        #[arg(long)]
        schedule: Option<String>,
    },
    /// Drop the OpenClaw skill and register the answering cron job.
    InstallOpenclaw {
        #[arg(long)]
        no_cron: bool,
        #[arg(long)]
        schedule: Option<String>,
        #[arg(long)]
        broker_url: Option<String>,
        #[arg(long)]
        bridge_url: Option<String>,
    },
    /// Print (as JSON) the open questions the policy permits answering.
    ListQuestions {
        #[arg(long)]
        broker_url: Option<String>,
    },
    /// Sign + submit one answer on the user's behalf; prints JSON.
    SubmitAnswer {
        #[arg(long)]
        question_id: String,
        #[arg(long)]
        answer: String,
        #[arg(long)]
        broker_url: Option<String>,
    },
    /// Record that the user has no formed view on one question (§1.14); prints JSON.
    SubmitNoSignal {
        #[arg(long)]
        question_id: String,
        #[arg(long)]
        broker_url: Option<String>,
    },
    /// Print (as JSON) the user's own recently submitted answers (local read).
    ReviewAnswers {
        #[arg(long, default_value_t = 20)]
        limit: i64,
    },
    /// Retract one of the user's previously-submitted answers; prints JSON.
    RevokeAnswer {
        #[arg(long)]
        question_id: String,
        #[arg(long)]
        broker_url: Option<String>,
    },
    /// Import a downloaded ChatGPT export into Hearme's local memory DB.
    ChatgptImport {
        /// Path to ChatGPT export ZIP, extracted directory, or conversations.json.
        export_path: String,
        #[arg(long)]
        db: Option<String>,
        #[arg(long)]
        include_assistant: bool,
    },
    /// Query the imported ChatGPT memory DB.
    ChatgptQuery {
        text: String,
        #[arg(long)]
        topic: Option<String>,
        #[arg(long, default_value_t = 5)]
        limit: i64,
        #[arg(long)]
        db: Option<String>,
    },
    /// Show the host-model API spend this addon's answering cron has created
    /// (read from Hermes' per-session usage DB) and the monthly budget cap.
    Cost {
        /// Emit the full report as JSON instead of a human summary.
        #[arg(long)]
        json: bool,
    },
}

/// Parse argv and dispatch. Returns the process exit code.
pub fn run() -> i32 {
    let cli = Cli::parse();
    // Did the user explicitly point us at a profile/home? Computed BEFORE
    // apply_hermes_home mutates the env, so the ambiguity guard can tell an
    // inherited/flagged target apart from a bare default-profile install.
    let explicit_target = cli.hermes_profile.is_some()
        || cli.hermes_home.is_some()
        || std::env::var_os("HERMES_HOME").is_some_and(|v| !v.is_empty());
    apply_hermes_home(cli.hermes_profile.as_deref(), cli.hermes_home.as_deref());
    match cli.command {
        Command::Onboard {
            bridge_url,
            broker_url,
            profile,
            timeout,
            no_wait,
            host,
        } => cmd_onboard(
            bridge_url,
            broker_url,
            &profile,
            timeout,
            no_wait,
            host,
            explicit_target,
        ),
        Command::AcceptMockDelegation { token_path } => cmd_accept_mock(&token_path),
        Command::Schedule { .. } => cmd_schedule(),
        Command::InstallPlugin {
            no_restart,
            broker_url,
            bridge_url,
        } => cmd_install_plugin(
            no_restart,
            broker_url.as_deref(),
            bridge_url.as_deref(),
            explicit_target,
        ),
        Command::Install {
            host,
            no_restart,
            no_cron,
            schedule,
        } => cmd_install(
            host,
            no_restart,
            no_cron,
            schedule.as_deref(),
            explicit_target,
        ),
        Command::InstallOpenclaw {
            no_cron,
            schedule,
            broker_url,
            bridge_url,
        } => cmd_install_openclaw(
            no_cron,
            schedule.as_deref(),
            broker_url.as_deref(),
            bridge_url.as_deref(),
        ),
        Command::ListQuestions { broker_url } => {
            print_json(&tools::list_open_questions(&settings_for(
                broker_url.as_deref(),
            )));
            0
        }
        Command::SubmitAnswer {
            question_id,
            answer,
            broker_url,
        } => {
            let result =
                tools::submit_answer(&question_id, &answer, &settings_for(broker_url.as_deref()));
            let accepted = result
                .get("accepted")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            print_json(&result);
            if accepted {
                0
            } else {
                1
            }
        }
        Command::SubmitNoSignal {
            question_id,
            broker_url,
        } => {
            let result =
                tools::submit_no_signal(&question_id, &settings_for(broker_url.as_deref()));
            let accepted = result
                .get("accepted")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            print_json(&result);
            if accepted {
                0
            } else {
                1
            }
        }
        Command::ReviewAnswers { limit } => {
            print_json(&tools::review_my_answers(limit, &settings_for(None)));
            0
        }
        Command::RevokeAnswer {
            question_id,
            broker_url,
        } => {
            let result = tools::revoke_answer(&question_id, &settings_for(broker_url.as_deref()));
            let accepted = result
                .get("accepted")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            print_json(&result);
            if accepted {
                0
            } else {
                1
            }
        }
        Command::ChatgptImport {
            export_path,
            db,
            include_assistant,
        } => cmd_chatgpt_import(&export_path, db.as_deref(), include_assistant),
        Command::ChatgptQuery {
            text,
            topic,
            limit,
            db,
        } => cmd_chatgpt_query(&text, topic.as_deref(), limit, db.as_deref()),
        Command::Cost { json } => cmd_cost(json),
    }
}

fn print_json(value: &serde_json::Value) {
    println!(
        "{}",
        serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string())
    );
}

fn settings_for(broker_url: Option<&str>) -> Settings {
    let mut s = get_settings();
    if let Some(url) = broker_url {
        s.broker_url = url.to_string();
    }
    s
}

fn ensure_root(settings: &Settings) {
    let _ = std::fs::create_dir_all(&settings.root_dir);
}

/// Translate `--hermes-profile`/`--hermes-home` into `$HERMES_HOME` for this
/// process, so every downstream path helper (plugin dir, env file, state root,
/// and the generated shim) resolves to the same Hermes home. `--hermes-home`
/// wins; a profile name resolves under the real `~/.hermes/profiles/<name>`
/// (never under an inherited $HERMES_HOME). With neither flag, an inherited
/// $HERMES_HOME is left untouched.
fn apply_hermes_home(profile: Option<&str>, home: Option<&Path>) {
    let target = home
        .map(PathBuf::from)
        .or_else(|| profile.map(|name| hermes::default_hermes_root().join("profiles").join(name)));
    if let Some(path) = target {
        // SAFETY: called once at startup, before any threads are spawned.
        unsafe { std::env::set_var("HERMES_HOME", path) };
    }
}

/// When about to install into the default profile while named profiles exist
/// and the user named no target, warn — otherwise the plugin lands in a profile
/// the active gateway may not be running.
fn warn_if_ambiguous_profile(explicit_target: bool) {
    if explicit_target {
        return;
    }
    let profiles = hermes::list_profiles();
    if profiles.is_empty() {
        return;
    }
    eprintln!(
        "Note: targeting the DEFAULT Hermes profile ({}), but other profiles exist: {}.",
        hermes::hermes_home().display(),
        profiles.join(", ")
    );
    eprintln!(
        "      If your agent runs under one of those, re-run scoped to it, e.g.:\n        hearme-skill --hermes-profile {} <command>",
        profiles[0]
    );
}

fn resolve_hosts(host: &str) -> Vec<&'static str> {
    match host {
        "both" => vec!["hermes", "openclaw"],
        "hermes" => vec!["hermes"],
        "openclaw" => vec!["openclaw"],
        _ => {
            let mut hosts = Vec::new();
            if hermes::hermes_home().exists() {
                hosts.push("hermes");
            }
            if openclaw::openclaw_available() {
                hosts.push("openclaw");
            }
            if hosts.is_empty() {
                hosts.push("hermes");
            }
            hosts
        }
    }
}

// --- onboarding -----------------------------------------------------------

fn cmd_onboard(
    bridge_url: Option<String>,
    broker_url: Option<String>,
    profile: &str,
    timeout: f64,
    no_wait: bool,
    host: HostArg,
    explicit_target: bool,
) -> i32 {
    let settings = get_settings();
    ensure_root(&settings);
    let bridge_url = bridge_url.unwrap_or_else(|| settings.self_bridge_url.clone());
    let broker_url = broker_url.unwrap_or_else(|| settings.broker_url.clone());

    let request =
        match onboarding::begin_onboarding(&settings.agent_key_path(), &bridge_url, profile) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("onboarding failed: {e}");
                return 2;
            }
        };

    println!("Scan these QR codes with the Self app (one per age threshold):\n");
    for (i, url) in request.urls.iter().enumerate() {
        println!("--- proof {} of {} ---", i + 1, request.urls.len());
        println!("{}", onboarding::render_qr_ascii(url));
        println!("Or open: {url}\n");
    }
    if no_wait {
        println!(
            "request_id={} (run without --no-wait to store the token)",
            request.request_id
        );
        return 0;
    }

    println!("Waiting for the proofs from your phone, then registering with the broker...");
    let token = match onboarding::complete_onboarding(
        &bridge_url,
        &broker_url,
        &request.request_id,
        &request.agent_public_key,
        &settings.delegation_path(),
        timeout,
    ) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("onboarding failed: {e}");
            return 2;
        }
    };
    println!("Stored delegation token (expires {})", token.expires_at());

    // Persist explicitly-set broker/bridge URLs so the scheduled run hits the
    // same broker (a fresh process won't inherit this shell's env).
    let defaults = Settings::defaults();
    if let Ok(Some(keys)) = hermes::persist_broker_urls(
        Some(&broker_url),
        Some(&bridge_url),
        &defaults.broker_url,
        &defaults.self_bridge_url,
        &hermes::hermes_env_path(),
    ) {
        println!(
            "Persisted {} to {}.",
            keys.join(", "),
            hermes::hermes_env_path().display()
        );
    }

    post_onboard_setup(host, &broker_url, &bridge_url, explicit_target);
    0
}

fn post_onboard_setup(host: HostArg, broker_url: &str, bridge_url: &str, explicit_target: bool) {
    let hosts = resolve_hosts(host.as_str());
    if hosts.contains(&"hermes") {
        warn_if_ambiguous_profile(explicit_target);
        match hermes::install_plugin_dir(None, None) {
            Ok(target) => {
                println!("Installed Hermes plugin drop-in at {}.", target.display());
                enable_hermes_plugin();
                let (ok, msg) = hermes::restart_gateway();
                if ok {
                    println!("{msg}; the hearme tools are now loaded (the cron job self-registers).");
                } else {
                    eprintln!(
                        "Plugin written, but the gateway was not restarted ({msg}). Restart it to load the tools:\n  {}",
                        hermes::gateway_restart_hint()
                    );
                }
            }
            Err(e) => eprintln!("Note: could not write the Hermes plugin drop-in ({e}). Run `hearme-skill install-plugin` to retry."),
        }
    }
    if hosts.contains(&"openclaw") {
        match openclaw::install_openclaw_skill(None) {
            Ok(target) => {
                println!("Installed OpenClaw skill at {}.", target.join("SKILL.md").display());
                let defaults = Settings::defaults();
                if let Ok(Some(keys)) = hermes::persist_broker_urls(
                    Some(broker_url),
                    Some(bridge_url),
                    &defaults.broker_url,
                    &defaults.self_bridge_url,
                    &openclaw::openclaw_env_path(),
                ) {
                    println!("Persisted {} to {}.", keys.join(", "), openclaw::openclaw_env_path().display());
                }
                report_openclaw_cron(&openclaw::ensure_openclaw_cron(None, None));
            }
            Err(e) => eprintln!("Note: could not write the OpenClaw skill ({e}). Run `hearme-skill install-openclaw` to retry."),
        }
    }
}

/// Register `hearme` in the active profile's plugin allow-list so the gateway
/// actually loads the drop-in. Standalone plugins are opt-in; without this the
/// gateway discovers the plugin but skips it, and the cron never self-registers.
/// Best-effort — a parse failure prints the manual fallback rather than aborting.
fn enable_hermes_plugin() {
    let path = hermes::config_path();
    match hermes::enable_plugin_in_config(&path) {
        Ok(true) => println!("Enabled the hearme plugin in {}.", path.display()),
        Ok(false) => {} // already in plugins.enabled — nothing to do
        Err(e) => eprintln!(
            "Note: could not enable the hearme plugin in {} ({e}). Standalone plugins are opt-in; enable it by hand, then restart the gateway:\n  hermes plugins enable hearme",
            path.display()
        ),
    }
}

fn cmd_accept_mock(token_path: &str) -> i32 {
    let settings = get_settings();
    ensure_root(&settings);
    let raw = if token_path == "-" {
        let mut buf = String::new();
        if let Err(e) = std::io::stdin().read_to_string(&mut buf) {
            eprintln!("could not read token from stdin: {e}");
            return 2;
        }
        buf
    } else {
        match std::fs::read_to_string(token_path) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("could not read {token_path}: {e}");
                return 2;
            }
        }
    };
    match onboarding::accept_identity_bundle(&raw, &settings.delegation_path()) {
        Ok(token) => {
            println!("Stored delegation token (expires {})", token.expires_at());
            0
        }
        Err(e) => {
            eprintln!("could not accept delegation token: {e}");
            2
        }
    }
}

fn cmd_schedule() -> i32 {
    // The Hermes `cron` API ships inside the gateway's Python env, which the
    // standalone binary is not part of. The generated plugin shim self-registers
    // the job once you onboard, so this command is a no-op here.
    eprintln!(
        "could not register the Hermes cron job from the standalone binary (the cron API lives inside the Hermes gateway).\n\
         The plugin shim self-registers it once a delegation token exists — run `hearme-skill install` then `hearme-skill onboard`."
    );
    2
}

// --- installers -----------------------------------------------------------

fn persist_urls(broker_url: Option<&str>, bridge_url: Option<&str>, env_path: &Path) {
    if broker_url.is_none() && bridge_url.is_none() {
        return;
    }
    let defaults = Settings::defaults();
    match hermes::persist_broker_urls(
        broker_url,
        bridge_url,
        &defaults.broker_url,
        &defaults.self_bridge_url,
        env_path,
    ) {
        Ok(Some(keys)) => println!("Persisted {} to {}.", keys.join(", "), env_path.display()),
        Ok(None) => {}
        Err(e) => eprintln!(
            "Could not persist broker URLs to {} ({e}).",
            env_path.display()
        ),
    }
}

fn cmd_install_plugin(
    no_restart: bool,
    broker_url: Option<&str>,
    bridge_url: Option<&str>,
    explicit_target: bool,
) -> i32 {
    warn_if_ambiguous_profile(explicit_target);
    let target = match hermes::install_plugin_dir(None, None) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("could not write the Hermes plugin drop-in: {e}");
            return 2;
        }
    };
    println!("Wrote Hermes plugin drop-in to {}", target.display());
    enable_hermes_plugin();
    persist_urls(broker_url, bridge_url, &hermes::hermes_env_path());

    if no_restart {
        println!("Restart the Hermes gateway to load the plugin:");
        println!("  {}", hermes::gateway_restart_hint());
        return 0;
    }
    let (ok, msg) = hermes::restart_gateway();
    if ok {
        let mut m = msg;
        if let Some(first) = m.get_mut(0..1) {
            first.make_ascii_uppercase();
        }
        println!("{m}.");
    } else {
        eprintln!(
            "Could not auto-restart the gateway ({msg}). Restart it manually:\n  {}",
            hermes::gateway_restart_hint()
        );
    }
    0
}

fn report_openclaw_cron(result: &openclaw::CronResult) {
    if result.created {
        println!(
            "Registered OpenClaw cron job '{}'.",
            result.name.as_deref().unwrap_or(openclaw::CRON_NAME)
        );
    } else if result.reason.as_deref() == Some("already present") {
        println!(
            "OpenClaw cron job '{}' already present.",
            result.name.as_deref().unwrap_or(openclaw::CRON_NAME)
        );
    } else {
        let reason = result.reason.as_deref().unwrap_or("unknown");
        eprintln!(
            "Note: could not register the OpenClaw cron job ({reason}). Register it by hand once OpenClaw is running:\n  openclaw cron add --name {} --cron \"{}\" --session isolated --message \"{}\"",
            openclaw::CRON_NAME,
            openclaw::DEFAULT_SCHEDULE,
            openclaw::CRON_MESSAGE,
        );
    }
}

fn cmd_install(
    host: HostArg,
    no_restart: bool,
    no_cron: bool,
    schedule: Option<&str>,
    explicit_target: bool,
) -> i32 {
    let hosts = resolve_hosts(host.as_str());
    let mut done = 0;

    if hosts.contains(&"hermes") {
        warn_if_ambiguous_profile(explicit_target);
        match hermes::install_plugin_dir(None, None) {
            Ok(target) => {
                println!("Installed Hermes plugin drop-in at {}.", target.display());
                enable_hermes_plugin();
                if !no_restart {
                    let (ok, msg) = hermes::restart_gateway();
                    if ok {
                        let mut m = msg;
                        if let Some(first) = m.get_mut(0..1) {
                            first.make_ascii_uppercase();
                        }
                        println!("{m}.");
                    } else {
                        eprintln!(
                            "Could not auto-restart the gateway ({msg}). Restart it manually:\n  {}",
                            hermes::gateway_restart_hint()
                        );
                    }
                }
                done += 1;
            }
            Err(e) => eprintln!("could not install Hermes plugin: {e}"),
        }
    }

    if hosts.contains(&"openclaw") {
        match openclaw::install_openclaw_skill(None) {
            Ok(target) => {
                println!(
                    "Installed OpenClaw skill at {}.",
                    target.join("SKILL.md").display()
                );
                if !no_cron {
                    report_openclaw_cron(&openclaw::ensure_openclaw_cron(schedule, None));
                }
                done += 1;
            }
            Err(e) => eprintln!("could not install OpenClaw skill: {e}"),
        }
    }

    if done == 0 {
        eprintln!(
            "No supported agent detected (looked for ~/.hermes and OpenClaw on PATH / ~/.openclaw). Re-run with --host hermes|openclaw|both."
        );
        return 1;
    }
    println!("Next: run `hearme-skill onboard --broker-url <url> --bridge-url <url>` once to set up your Self identity.");
    0
}

fn cmd_install_openclaw(
    no_cron: bool,
    schedule: Option<&str>,
    broker_url: Option<&str>,
    bridge_url: Option<&str>,
) -> i32 {
    let target = match openclaw::install_openclaw_skill(None) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("could not write the OpenClaw skill: {e}");
            return 2;
        }
    };
    println!(
        "Wrote OpenClaw skill to {}",
        target.join("SKILL.md").display()
    );
    persist_urls(broker_url, bridge_url, &openclaw::openclaw_env_path());
    if !no_cron {
        report_openclaw_cron(&openclaw::ensure_openclaw_cron(schedule, None));
    }
    println!("OpenClaw snapshots skills at session start — start a new session (or run `openclaw gateway restart`) to pick up hearme.");
    0
}

// --- chatgpt memory -------------------------------------------------------

fn cmd_chatgpt_import(export_path: &str, db: Option<&str>, include_assistant: bool) -> i32 {
    let settings = get_settings();
    ensure_root(&settings);
    let db_path = db
        .map(PathBuf::from)
        .unwrap_or_else(|| settings.chatgpt_memory_path());
    match crate::chatgpt::import_chatgpt_export(Path::new(export_path), &db_path, include_assistant)
    {
        Ok(stats) => {
            println!(
                "Imported {} conversations and {} message chunks into {}",
                stats.conversations,
                stats.chunks,
                stats.db_path.display()
            );
            println!(
                "Use HEARME_SKILL_MEMORY_BACKEND=chatgpt-export to answer from this memory DB."
            );
            0
        }
        Err(e) => {
            eprintln!("ChatGPT import failed: {e}");
            2
        }
    }
}

// --- cost / budget --------------------------------------------------------

fn cmd_cost(as_json: bool) -> i32 {
    let settings = get_settings();
    let report = crate::cost::report(&settings);
    crate::cost::write_snapshot(&settings, &report);

    if as_json {
        let value = serde_json::to_value(&report).unwrap_or_else(|_| serde_json::json!({}));
        print_json(&value);
        return 0;
    }

    if !report.available {
        println!(
            "Cost tracking unavailable: {}",
            report.reason.as_deref().unwrap_or("unknown")
        );
        println!("No host-model spend could be attributed, so the budget guard fails open (answering is never blocked by a number we can't read).");
        return 0;
    }

    println!("Hearme answering-cron cost — host-model API spend (read from Hermes' usage DB)");
    println!(
        "  This month ({}): ${:.4}  over {} run(s)",
        report.current_month, report.current_month_cost_usd, report.current_month_runs
    );
    println!(
        "  Monthly budget:  ${:.2}  (remaining ${:.4}){}",
        report.monthly_budget_usd,
        report.remaining_usd,
        if report.over_budget {
            "  [OVER BUDGET — answering paused until next month]"
        } else {
            ""
        }
    );
    println!(
        "  Lifetime:        ${:.4}  over {} run(s)",
        report.lifetime_cost_usd, report.lifetime_runs
    );
    if report.by_month.len() > 1 {
        println!("  By month:");
        for (m, c) in &report.by_month {
            println!("    {m}: ${c:.4}");
        }
    }
    println!(
        "  Basis: {}  •  budget override: HEARME_SKILL_MONTHLY_BUDGET_USD",
        if report.has_actual_cost {
            "actual + estimated provider pricing"
        } else {
            "estimated provider pricing"
        }
    );
    println!("  Snapshot: {}", settings.cost_snapshot_path().display());
    0
}

fn cmd_chatgpt_query(text: &str, topic: Option<&str>, limit: i64, db: Option<&str>) -> i32 {
    let settings = get_settings();
    let db_path = db
        .map(PathBuf::from)
        .unwrap_or_else(|| settings.chatgpt_memory_path());
    match crate::chatgpt::query(&db_path, topic, text, limit) {
        Ok(facts) => {
            for fact in facts {
                println!("- {fact}");
            }
            0
        }
        Err(e) => {
            eprintln!("ChatGPT query failed: {e}");
            2
        }
    }
}
