"""Tests for the OpenClaw adapter (skill install, cron, answering CLI).

The OpenClaw host reuses the SAME framework-agnostic core as the Hermes plugin
(``tools.py``); these tests pin the OpenClaw-specific glue: the SKILL.md the
agent reads, the install drop-in, the cron best-effort, and the JSON-printing
CLI wrappers the skill calls via `exec`.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from hearme_skill import openclaw, skill

REPO_SKILL_MD = (
    Path(__file__).resolve().parents[1] / "openclaw" / "hearme" / "SKILL.md"
)


def test_committed_skill_md_matches_embedded_source() -> None:
    """The committed SKILL.md must be byte-identical to the embedded constant.

    The embedded `SKILL_MD` is what `install-openclaw` writes; the committed
    file is what `openclaw skills install ./...` reads. They must never drift.
    """

    assert REPO_SKILL_MD.read_text() == openclaw.SKILL_MD


def test_skill_md_frontmatter_shape() -> None:
    text = openclaw.SKILL_MD
    assert text.startswith("---\n")
    assert "\nname: hearme\n" in text
    assert "\ndescription:" in text
    # metadata gating must stay on a single line (OpenClaw parses it as JSON).
    meta_line = next(ln for ln in text.splitlines() if ln.startswith("metadata:"))
    json.loads(meta_line[len("metadata:") :].strip())
    # The skill drives the shared CLI, not bespoke tools.
    assert "hearme-skill list-questions" in text
    assert "hearme-skill submit-answer" in text


def test_install_openclaw_skill_writes_skill_md(tmp_path: Path) -> None:
    target = openclaw.install_openclaw_skill(skills_dir=tmp_path)
    assert target == tmp_path / "hearme"
    written = target / "SKILL.md"
    assert written.read_text() == openclaw.SKILL_MD
    # Idempotent: a second call cleanly overwrites.
    openclaw.install_openclaw_skill(skills_dir=tmp_path)
    assert written.read_text() == openclaw.SKILL_MD


def test_ensure_cron_skips_without_openclaw_cli(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(openclaw.shutil, "which", lambda _name: None)
    result = openclaw.ensure_openclaw_cron()
    assert result == {
        "created": False,
        "skipped": True,
        "reason": "openclaw CLI not found on PATH",
    }


def test_ensure_cron_idempotent_when_already_present(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(openclaw.shutil, "which", lambda _name: "/usr/bin/openclaw")

    class _Listing:
        stdout = f"some-other-job\n{openclaw.CRON_NAME}\n"

    calls: list[list[str]] = []

    def fake_run(cmd, **_kwargs):  # noqa: ANN001
        calls.append(cmd)
        return _Listing()

    monkeypatch.setattr(openclaw.subprocess, "run", fake_run)
    result = openclaw.ensure_openclaw_cron()
    assert result == {"created": False, "name": openclaw.CRON_NAME, "reason": "already present"}
    # Only `cron list` should have run — no `cron add`.
    assert calls == [["/usr/bin/openclaw", "cron", "list"]]


def test_resolve_hosts_explicit() -> None:
    assert skill._resolve_hosts("hermes") == ["hermes"]
    assert skill._resolve_hosts("openclaw") == ["openclaw"]
    assert skill._resolve_hosts("both") == ["hermes", "openclaw"]


def test_resolve_hosts_auto_detects(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    # Neither host present -> falls back to hermes (back-compat).
    monkeypatch.setattr(skill.Path, "home", classmethod(lambda _cls: tmp_path))
    monkeypatch.setattr(openclaw, "openclaw_available", lambda: False)
    assert skill._resolve_hosts("auto") == ["hermes"]
    # OpenClaw detected, no ~/.hermes -> openclaw only.
    monkeypatch.setattr(openclaw, "openclaw_available", lambda: True)
    assert skill._resolve_hosts("auto") == ["openclaw"]


def test_settings_for_overrides_broker_url() -> None:
    from hearme_skill.config import get_settings

    s = skill._settings_for("http://example.invalid:9000")
    assert s.broker_url == "http://example.invalid:9000"
    # No override -> same broker URL as the ambient settings.
    assert skill._settings_for(None).broker_url == get_settings().broker_url


def _run_cli(monkeypatch: pytest.MonkeyPatch, argv: list[str]) -> int:
    monkeypatch.setattr(sys, "argv", ["hearme-skill", *argv])
    return skill.cli()


def test_list_questions_cli_prints_json(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    from hearme_skill import tools

    payload = {"questions": [{"question_id": "q1", "options": ["yes", "no"]}], "skipped_count": 2}
    monkeypatch.setattr(tools, "list_open_questions", lambda **_kw: payload)
    rc = _run_cli(monkeypatch, ["list-questions"])
    assert rc == 0
    assert json.loads(capsys.readouterr().out) == payload


def test_submit_answer_cli_exit_code_tracks_accepted(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    from hearme_skill import tools

    seen: dict = {}

    def fake_submit(question_id, answer_text, **_kw):  # noqa: ANN001
        seen["args"] = (question_id, answer_text)
        return {"accepted": True, "reason": "ok", "question_id": question_id}

    monkeypatch.setattr(tools, "submit_answer", fake_submit)
    rc = _run_cli(
        monkeypatch,
        ["submit-answer", "--question-id", "q1", "--answer", "Yes — I love it"],
    )
    assert rc == 0
    assert seen["args"] == ("q1", "Yes — I love it")
    assert json.loads(capsys.readouterr().out)["accepted"] is True

    monkeypatch.setattr(
        tools,
        "submit_answer",
        lambda *_a, **_k: {"accepted": False, "reason": "policy-declined", "question_id": "q1"},
    )
    rc = _run_cli(
        monkeypatch, ["submit-answer", "--question-id", "q1", "--answer", "No"]
    )
    assert rc == 1
