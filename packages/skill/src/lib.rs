//! Chorum standalone skill — library core.
//!
//! The production answering path runs *inside* the user's agent host (Hermes or
//! OpenClaw). Both hosts ultimately shell out to the `chorum-skill` binary, so
//! the entire skill is a single Rust crate: a small set of framework-agnostic
//! functions ([`tools`]) over the broker protocol, plus thin per-host install
//! adapters ([`hermes`], [`openclaw`]).
//!
//! Privacy and signing invariants are enforced HERE, never in a prompt: the
//! DelegationToken and signing nonce never leave the crate, and the policy gate
//! ([`policy::decide`]) is re-checked on every submit.
//!
//! Byte-compatibility with the TypeScript broker (`packages/broker`) is the
//! load-bearing contract; see [`canonical`] and the golden-vector tests.

pub mod broker;
pub mod canonical;
pub mod chatgpt;
pub mod cli;
pub mod config;
pub mod contracts;
pub mod cost;
pub mod crypto;
pub mod delegation;
pub mod envelope;
pub mod hermes;
pub mod ledger;
pub mod models;
pub mod onboarding;
pub mod openclaw;
pub mod policy;
pub mod tools;

/// Crate-wide error type. The CLI converts these into stderr + exit codes; the
/// answering tools convert them into structured JSON instead of propagating.
pub type Error = Box<dyn std::error::Error + Send + Sync>;
pub type Result<T> = std::result::Result<T, Error>;
