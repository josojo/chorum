//! Command-line interface — the binary's whole surface.
//!
//! Mirrors the original Python `argparse` CLI command-for-command so the
//! generated Hermes shim and the OpenClaw SKILL.md (both of which invoke these
//! subcommands) keep working unchanged. Answering commands print JSON to stdout;
//! their exit code tracks `accepted` where applicable.

use std::io::{IsTerminal, Read, Write};
use std::path::{Path, PathBuf};

use clap::{Parser, Subcommand, ValueEnum};

use crate::config::{get_settings, Settings};
use crate::{hermes, onboarding, openclaw, tools};

#[derive(Parser)]
#[command(name = "hearme-skill", version, about = "Hearme standalone skill CLI")]
struct Cli {
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
}

/// Parse argv and dispatch. Returns the process exit code.
pub fn run() -> i32 {
    let cli = Cli::parse();
    match cli.command {
        Command::Onboard {
            bridge_url,
            broker_url,
            profile,
            timeout,
            no_wait,
            host,
        } => cmd_onboard(bridge_url, broker_url, &profile, timeout, no_wait, host),
        Command::AcceptMockDelegation { token_path } => cmd_accept_mock(&token_path),
        Command::Schedule { .. } => cmd_schedule(),
        Command::InstallPlugin {
            no_restart,
            broker_url,
            bridge_url,
        } => cmd_install_plugin(no_restart, broker_url.as_deref(), bridge_url.as_deref()),
        Command::Install {
            host,
            no_restart,
            no_cron,
            schedule,
        } => cmd_install(host, no_restart, no_cron, schedule.as_deref()),
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
    }
}

fn print_json(value: &serde_json::Value) {
    println!(
        "{}",
        serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string())
    );
}

/// Print a prompt and block until the user presses Enter (onboarding pacing).
fn wait_for_enter(prompt: &str) {
    print!("{prompt}");
    let _ = std::io::stdout().flush();
    let mut buf = String::new();
    let _ = std::io::stdin().read_line(&mut buf);
}

/// Clear the terminal (ANSI erase + cursor home). Terminals that don't support
/// the escapes simply ignore them.
fn clear_screen() {
    print!("\x1b[2J\x1b[H");
    let _ = std::io::stdout().flush();
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

fn resolve_hosts(host: &str) -> Vec<&'static str> {
    match host {
        "both" => vec!["hermes", "openclaw"],
        "hermes" => vec!["hermes"],
        "openclaw" => vec!["openclaw"],
        _ => {
            let mut hosts = Vec::new();
            if dirs::home_dir()
                .map(|h| h.join(".hermes").exists())
                .unwrap_or(false)
            {
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

    // Two-step UX so the QR isn't buried under text (which forced users to zoom
    // to scan): first explain, then — on Enter — clear the screen and show only
    // the big QR with a short "scan in the Self app" line. Pauses are skipped
    // when stdin isn't a terminal (e.g. piped) or with --no-wait.
    let interactive = std::io::stdin().is_terminal() && !no_wait;
    let n = request.urls.len();

    // Step 1 — explanation only.
    println!();
    println!("Step 1 of 2 — verify you're a unique human with the Self app");
    println!();
    println!("  1. Install the Self app (https://self.xyz) and have your passport/ID ready.");
    if n > 1 {
        println!(
            "  2. Next you'll see {n} QR codes (one per age threshold) — scan each with Self."
        );
    } else {
        println!("  2. Next you'll see a QR code — scan it with the Self app.");
    }
    println!("  3. Your passport never leaves your phone; Hearme only learns a yes/no proof.");
    println!();
    if interactive {
        wait_for_enter("Press Enter to show the QR code...");
    }

    // Step 2 — the QR(s) only: big code + a single "scan in the Self app" line.
    for (i, url) in request.urls.iter().enumerate() {
        if interactive {
            clear_screen();
        }
        if n > 1 {
            println!("Scan in the Self app  ({} of {})", i + 1, n);
        } else {
            println!("Scan in the Self app");
        }
        println!();
        println!("{}", onboarding::render_qr_ascii(url));
        println!("Can't scan? Open this link on your phone:\n{url}");
        if interactive && i + 1 < n {
            println!();
            wait_for_enter("Press Enter for the next code...");
        }
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

    post_onboard_setup(host, &broker_url, &bridge_url);
    0
}

fn post_onboard_setup(host: HostArg, broker_url: &str, bridge_url: &str) {
    let hosts = resolve_hosts(host.as_str());
    if hosts.contains(&"hermes") {
        match hermes::install_plugin_dir(None, None) {
            Ok(target) => {
                println!("Installed Hermes plugin drop-in at {}.", target.display());
                let (ok, msg) = hermes::restart_gateway();
                if ok {
                    println!("Restarted hermes-gateway; the hearme tools are now loaded (the cron job self-registers).");
                } else {
                    eprintln!(
                        "Plugin written, but the gateway was not restarted ({msg}). Restart it to load the tools:\n  systemctl --user restart hermes-gateway"
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

fn cmd_install_plugin(no_restart: bool, broker_url: Option<&str>, bridge_url: Option<&str>) -> i32 {
    let target = match hermes::install_plugin_dir(None, None) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("could not write the Hermes plugin drop-in: {e}");
            return 2;
        }
    };
    println!("Wrote Hermes plugin drop-in to {}", target.display());
    persist_urls(broker_url, bridge_url, &hermes::hermes_env_path());

    if no_restart {
        println!("Restart the Hermes gateway to load the plugin:");
        println!("  systemctl --user restart hermes-gateway");
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
        eprintln!("Could not auto-restart the gateway ({msg}). Restart it manually:\n  systemctl --user restart hermes-gateway");
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

fn cmd_install(host: HostArg, no_restart: bool, no_cron: bool, schedule: Option<&str>) -> i32 {
    let hosts = resolve_hosts(host.as_str());
    let mut done = 0;

    if hosts.contains(&"hermes") {
        match hermes::install_plugin_dir(None, None) {
            Ok(target) => {
                println!("Installed Hermes plugin drop-in at {}.", target.display());
                if !no_restart {
                    let (ok, msg) = hermes::restart_gateway();
                    if ok {
                        println!("Restarted hermes-gateway.");
                    } else {
                        eprintln!("Could not auto-restart the gateway ({msg}). Restart it manually:\n  systemctl --user restart hermes-gateway");
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
