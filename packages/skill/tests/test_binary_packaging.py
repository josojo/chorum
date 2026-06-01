"""Tests for the standalone-binary install path.

Covers the parts that don't need a real PyInstaller build or a live agent:

* the generated Hermes subprocess shim is valid Python, stdlib-only at import
  time, and faithful to the canonical tool schemas;
* ``install_plugin_dir`` picks the right shim (binary vs pip mode);
* the unified ``hearme-skill install`` command dispatches per host;
* the packaging assets (install.sh, PyInstaller spec, CI workflow) exist and
  look right.

The actual binary build + smoke test runs in CI (build-binaries.yml).
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from hearme_skill import hermes_shim, skill
from hearme_skill.plugin import _LIST_SCHEMA, _SUBMIT_SCHEMA, TOOLSET

SKILL_PKG_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = SKILL_PKG_ROOT.parents[1]

BIN = "/opt/hearme/bin/hearme-skill"


def _exec_shim(source: str) -> dict:
    """Compile + exec the generated shim in a fresh namespace, return it.

    Safe: the shim imports only the stdlib at module load (the `cron` import is
    lazy, inside `_ensure_cron`), so executing the module body has no side
    effects beyond defining names.
    """

    compile(source, "<shim>", "exec")  # raises SyntaxError if malformed
    ns: dict = {}
    exec(source, ns)  # noqa: S102 — trusted, self-generated source
    return ns


def test_subprocess_shim_is_valid_and_faithful() -> None:
    ns = _exec_shim(hermes_shim.build_subprocess_shim(BIN))

    # Baked-in binary path + canonical contract carried verbatim.
    assert ns["HEARME_BIN"] == BIN
    assert ns["TOOLSET"] == TOOLSET
    assert ns["_LIST_SCHEMA"] == _LIST_SCHEMA
    assert ns["_SUBMIT_SCHEMA"] == _SUBMIT_SCHEMA

    # The Hermes contract: a register() plus the two tool handlers.
    assert callable(ns["register"])
    assert callable(ns["_handle_list"])
    assert callable(ns["_handle_submit"])


def test_subprocess_shim_does_not_import_hearme_skill() -> None:
    """Binary mode means the gateway has NO hearme_skill package to import."""

    source = hermes_shim.build_subprocess_shim(BIN)
    assert "import hearme_skill" not in source
    assert "from hearme_skill" not in source
    # It must, however, drive the binary via the CLI subcommands.
    assert "list-questions" in source
    assert "submit-answer" in source


def test_subprocess_shim_handlers_shell_out(monkeypatch: pytest.MonkeyPatch) -> None:
    ns = _exec_shim(hermes_shim.build_subprocess_shim(BIN))
    calls: list[list[str]] = []

    class _Proc:
        stdout = '{"questions": [], "skipped_count": 0}'
        stderr = ""

    def fake_run(cmd, **_kwargs):  # noqa: ANN001
        calls.append(cmd)
        return _Proc()

    monkeypatch.setattr(ns["subprocess"], "run", fake_run)

    out = ns["_handle_list"]({})
    assert out == '{"questions": [], "skipped_count": 0}'
    assert calls[-1] == [BIN, "list-questions"]

    ns["_handle_submit"]({"question_id": "q1", "answer": "Yes — sure"})
    assert calls[-1] == [BIN, "submit-answer", "--question-id", "q1", "--answer", "Yes — sure"]


def test_submit_handler_rejects_missing_args() -> None:
    ns = _exec_shim(hermes_shim.build_subprocess_shim(BIN))
    import json

    out = json.loads(ns["_handle_submit"]({"question_id": "", "answer": ""}))
    assert out["accepted"] is False


def test_install_plugin_dir_binary_mode(tmp_path: Path) -> None:
    target = skill.install_plugin_dir(plugin_dir=tmp_path, binary_path=BIN)
    shim = (target / "__init__.py").read_text()
    assert f"HEARME_BIN = {BIN!r}" in shim
    assert "subprocess" in shim
    assert (target / "plugin.yaml").exists()


def test_install_plugin_dir_pip_mode(tmp_path: Path) -> None:
    skill.install_plugin_dir(plugin_dir=tmp_path)
    shim = (tmp_path / "__init__.py").read_text()
    assert shim == hermes_shim.IMPORT_SHIM
    assert "from hearme_skill.plugin import register" in shim


def test_install_plugin_dir_frozen_autodetect(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", BIN, raising=False)
    skill.install_plugin_dir(plugin_dir=tmp_path)
    shim = (tmp_path / "__init__.py").read_text()
    assert f"HEARME_BIN = {BIN!r}" in shim


def _run_cli(monkeypatch: pytest.MonkeyPatch, argv: list[str]) -> int:
    monkeypatch.setattr(sys, "argv", ["hearme-skill", *argv])
    return skill.cli()


def test_install_cmd_openclaw_only(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from hearme_skill import openclaw

    seen: dict = {}
    monkeypatch.setattr(openclaw, "install_openclaw_skill", lambda: seen.setdefault("oc", tmp_path / "hearme"))
    monkeypatch.setattr(openclaw, "ensure_openclaw_cron", lambda **_k: {"created": True, "name": "x"})
    rc = _run_cli(monkeypatch, ["install", "--host", "openclaw"])
    assert rc == 0
    assert "oc" in seen


def test_install_cmd_hermes_only(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    seen: dict = {}
    monkeypatch.setattr(skill, "install_plugin_dir", lambda: seen.setdefault("h", tmp_path))
    monkeypatch.setattr(skill, "_restart_gateway", lambda: (True, "restarted"))
    rc = _run_cli(monkeypatch, ["install", "--host", "hermes"])
    assert rc == 0
    assert "h" in seen


# --- packaging assets exist and look right --------------------------------


def test_install_sh_present_and_shaped() -> None:
    sh = SKILL_PKG_ROOT / "scripts" / "install.sh"
    text = sh.read_text()
    assert text.startswith("#!/bin/sh")
    assert 'NAME="hearme-skill"' in text
    assert "${NAME}-${os_tag}-${arch_tag}" in text
    assert "aarch64" in text and "x86_64" in text


def test_pyinstaller_spec_and_entrypoint_present() -> None:
    assert (SKILL_PKG_ROOT / "pyinstaller" / "entrypoint.py").exists()
    spec = (SKILL_PKG_ROOT / "pyinstaller" / "hearme-skill.spec").read_text()
    assert 'name="hearme-skill"' in spec


def test_build_workflow_present() -> None:
    wf = REPO_ROOT / ".github" / "workflows" / "build-binaries.yml"
    text = wf.read_text()
    assert "ubuntu-24.04-arm" in text  # arm64 runner
    assert "pyinstaller pyinstaller/hearme-skill.spec" in text
