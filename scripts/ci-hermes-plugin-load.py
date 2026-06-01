#!/usr/bin/env python3
"""Load the generated Hermes plugin shim the way a gateway would, and assert it
wires up correctly.

`hermes plugins list` confirms Hermes *recognizes* the dropped-in manifest, but
it doesn't prove the shim's Python actually imports and registers its tools. This
harness closes that gap without needing a running gateway or a model: it imports
the generated ``~/.hermes/plugins/hearme/__init__.py`` shim, hands ``register()``
a recording context (like the gateway's plugin loader does), stubs the gateway's
``cron.jobs`` API, and asserts that:

  1. both tools (hearme_list_open_questions, hearme_submit_answer) get registered, and
  2. with a delegation token present, the answering cron job self-registers with
     the baked-in name / schedule / prompt.

This is the same __init__.py the real gateway loads, so a pass means "when a
clean Hermes gateway loads the hearme plugin, the plugin wires itself up."

Usage:
    ci-hermes-plugin-load.py [path/to/plugins/hearme/__init__.py]
"""

from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import types
from pathlib import Path


def main(argv: list[str]) -> int:
    default = Path.home() / ".hermes" / "plugins" / "hearme" / "__init__.py"
    shim_path = Path(argv[1]) if len(argv) > 1 else default
    if not shim_path.is_file():
        print(f"FATAL: plugin shim not found at {shim_path}", file=sys.stderr)
        print("       Run `hearme-skill install --host hermes` first.", file=sys.stderr)
        return 1

    # A delegation token must exist for the shim to self-register the cron, so
    # point the shim's agent home at a temp dir that has one.
    root = Path(tempfile.mkdtemp()) / "hearme-agent"
    root.mkdir(parents=True)
    (root / "delegation.token").write_text("{}")
    os.environ["HEARME_SKILL_ROOT_DIR"] = str(root)

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
    spec = importlib.util.spec_from_file_location("hearme_shim_under_test", shim_path)
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

    for tool in ("hearme_list_open_questions", "hearme_submit_answer"):
        if tool not in registered:
            failures.append(f"tool not registered: {tool}")
        elif not callable(registered[tool].get("handler")):
            failures.append(f"tool {tool} registered without a callable handler")

    if not created:
        failures.append("answering cron job did not self-register")
    else:
        job = created[0]
        if not job.get("name"):
            failures.append("cron job registered without a name")
        if not job.get("prompt"):
            failures.append("cron job registered without a prompt")
        if not job.get("schedule"):
            failures.append("cron job registered without a schedule")

    if failures:
        for f in failures:
            print(f"FATAL: {f}", file=sys.stderr)
        return 1

    print("== plugin-load PASS: the gateway shim registers both tools "
          f"({', '.join(sorted(registered))}) and self-registers cron job "
          f"'{created[0].get('name')}' ({created[0].get('schedule')}) ==")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
