//! Standalone `chorum-skill` binary entry point.
//!
//! Thin wrapper: parse argv, dispatch, exit with the chosen code. All logic
//! lives in the library crate so it can be unit-tested.

fn main() {
    std::process::exit(chorum_skill::cli::run());
}
