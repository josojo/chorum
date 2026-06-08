#!/usr/bin/env python3
"""Load the generated Hermes plugin shim the way a gateway would, and assert it
wires up correctly — optionally answering a question end-to-end through the
plugin's own registered tool handlers.

`hermes plugins list` confirms Hermes *recognizes* the dropped-in manifest, but
it doesn't prove the shim's Python actually imports, registers its tools, and
that calling those tools answers a question. This harness closes that gap without
needing a model: it imports the generated ``~/.hermes/plugins/chorum/__init__.py``
shim, hands ``register()`` a recording context (like the gateway's plugin loader
does), stubs the gateway's ``cron.jobs`` API, and asserts that:

  1. both tools (chorum_list_open_questions, chorum_submit_answer) get registered;
  2. with a delegation token present, the answering cron job self-registers with
     the baked-in name / schedule / prompt; and
  3. (when CHORUM_E2E_LIVE_SUBMIT=1) calling the *registered* tool handlers
     actually lists an open question and submits an accepted answer to a live
     broker — the same handler -> binary -> broker path a running gateway drives.

This is the same __init__.py the real gateway loads and the same handlers it would
call, so a pass means "when a clean Hermes gateway loads the chorum plugin, the
plugin wires itself up and its answer tool works against the broker." The only
things not exercised are a real gateway *process* dispatching the tool and an LLM
*deciding* to call it (both intentionally out of scope here).

Env:
  CHORUM_SKILL_ROOT_DIR   the agent home the shim/binary read (delegation + key).
                          If unset, a throwaway home with a dummy token is used
                          (enough for the wiring asserts, but not a live submit).
  CHORUM_SKILL_BROKER_URL broker the binary submits to (live submit only).
  CHORUM_E2E_LIVE_SUBMIT  set to 1 to run the live list+submit assertion.

Usage:
    ci-hermes-plugin-load.py [path/to/plugins/chorum/__init__.py]
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import types
from pathlib import Path


def main(argv: list[str]) -> int:
    default = Path.home() / ".hermes" / "plugins" / "chorum" / "__init__.py"
    shim_path = Path(argv[1]) if len(argv) > 1 else default
    if not shim_path.is_file():
        print(f"FATAL: plugin shim not found at {shim_path}", file=sys.stderr)
        print("       Run `chorum-skill install --host hermes` first.", file=sys.stderr)
        return 1

    live_submit = os.environ.get("CHORUM_E2E_LIVE_SUBMIT", "") in ("1", "true", "yes")

    # The shim resolves the agent home (delegation + key) from CHORUM_SKILL_ROOT_DIR.
    # Reuse a real onboarded home if one was passed in (required for a live
    # submit); otherwise make a throwaway one with a dummy token so the cron
    # self-registration path still fires.
    root = os.environ.get("CHORUM_SKILL_ROOT_DIR")
    if not root:
        if live_submit:
            print("FATAL: CHORUM_E2E_LIVE_SUBMIT=1 needs CHORUM_SKILL_ROOT_DIR "
                  "pointing at an onboarded agent home.", file=sys.stderr)
            return 1
        root = str(Path(tempfile.mkdtemp()) / "chorum-agent")
        Path(root).mkdir(parents=True)
        (Path(root) / "delegation.token").write_text("{}")
        os.environ["CHORUM_SKILL_ROOT_DIR"] = root

    # Stub the gateway-provided `cron.jobs` API the shim imports lazily.
    created: list[dict] = []
    cron_pkg = types.ModuleType("cron")
    cron_jobs = types.ModuleType("cron.jobs")

    def resolve_job_ref(_name):  # the job doesn't exist yet
        return None

    def create_job(**kwargs):
        created.append(kwargs)
        return {"id": "job-ci", **kwargs}

    # setattr on the synthetic modules (Pyright can't see dynamic members).
    setattr(cron_jobs, "resolve_job_ref", resolve_job_ref)
    setattr(cron_jobs, "create_job", create_job)
    setattr(cron_pkg, "jobs", cron_jobs)
    sys.modules["cron"] = cron_pkg
    sys.modules["cron.jobs"] = cron_jobs

    # Import the generated shim module from its file path.
    spec = importlib.util.spec_from_file_location("chorum_shim_under_test", shim_path)
    assert spec and spec.loader
    shim = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(shim)

    # A recording stand-in for the gateway's plugin-registration context.
    registered: dict[str, dict] = {}

    class RecordingCtx:
        def register_tool(self, *, name, **kwargs):
            registered[name] = kwargs

    if not hasattr(shim, "register"):
        print("FATAL: shim has no register(ctx) entry point", file=sys.stderr)
        return 1
    shim.register(RecordingCtx())

    failures: list[str] = []

    for tool in ("chorum_list_open_questions", "chorum_submit_answer"):
        if tool not in registered:
            failures.append(f"tool not registered: {tool}")
        elif not callable(registered[tool].get("handler")):
            failures.append(f"tool {tool} registered without a callable handler")

    if not created:
        failures.append("answering cron job did not self-register")
    else:
        job = created[0]
        for field in ("name", "prompt", "schedule"):
            if not job.get(field):
                failures.append(f"cron job registered without a {field}")

    if failures:
        for f in failures:
            print(f"FATAL: {f}", file=sys.stderr)
        return 1

    print("== plugin-load PASS: the gateway shim registers both tools "
          f"({', '.join(sorted(registered))}) and self-registers cron job "
          f"'{created[0].get('name')}' ({created[0].get('schedule')}) ==")

    if not live_submit:
        return 0

    # --- Live: answer a question through the plugin's OWN registered handlers ---
    # This is the continuous gateway path: registered tool handler -> chorum-skill
    # binary (the shim shells out to it) -> live broker. The list handler finds a
    # still-open question the agent hasn't answered; the submit handler signs and
    # posts the envelope. No question id is hard-coded: we answer whatever the
    # plugin's own list tool surfaces first.
    list_handler = registered["chorum_list_open_questions"]["handler"]
    listed = json.loads(list_handler({}))
    questions = listed.get("questions", [])
    if not questions:
        print("FATAL: the plugin's list tool returned no answerable questions "
              f"(error={listed.get('error')!r}).", file=sys.stderr)
        return 1
    qid = questions[0]["question_id"]
    print(f"-- plugin list tool surfaced {len(questions)} question(s); answering {qid}")

    submit_handler = registered["chorum_submit_answer"]["handler"]
    out = json.loads(submit_handler(
        {"question_id": qid, "answer": "Yes - answered via the Hermes plugin tool handler."}
    ))
    if not out.get("accepted"):
        print(f"FATAL: the plugin's submit tool was not accepted by the broker: {out}",
              file=sys.stderr)
        return 1

    print("== plugin-answer PASS: the chorum_submit_answer tool handler signed + "
          f"submitted an answer the broker accepted (question {qid}) ==")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
