"""End-to-end test: real Hermes agent answers a question via the broker.

ARCHITECTURE.md §12 "end-to-end" — the cross-cutting integration test the
architecture calls for, extended to use a *real* Hermes Agent backend
(``hermes-agent`` on PyPI) instead of the mock skill.

Flow:

    1. Spin up Postgres + broker locally. Postgres comes up via
       testcontainers; broker is started in-process as a uvicorn
       subprocess pointing at that Postgres.
    2. Tell the local Hermes agent something about the user
       ("I really hate cilantro and would never eat it").
    3. Insert a question into the database directly as ``hearme_admin``.
    4. Drive ONE iteration of the skill loop against the running
       broker — the skill polls, gets the question, asks Hermes, signs
       an envelope, posts to the broker.
    5. Assert the broker persisted an ``envelopes`` row and the answer
       reflects what Hermes was told (mentions cilantro, indicates
       dislike).

Skipped cleanly when:

* Docker / testcontainers is not available on the host.
* ``hermes-agent`` is not installed (``pip install -e '.[hermes]'`` in
  ``packages/skill``).
* ``OPEN_ROUTER_API_KEY`` (or ``OPENROUTER_API_KEY``) is missing.

Pieces still mocked / out of scope per the user's directive (phone
verification, money verification, real zkPassport circuit verification):
the DelegationToken is minted via ``scripts/mock-phone.py`` against the
broker's dev phone pubkey. Everything else is real.
"""

from __future__ import annotations

import asyncio
import json
import os
import socket
import subprocess
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest


REPO_ROOT = Path(__file__).resolve().parents[3]
SCHEMA_SQL = REPO_ROOT / "packages" / "web" / "drizzle" / "0000_init.sql"
ROLES_SQL = REPO_ROOT / "db" / "init" / "02-roles.sql"


# ---- prerequisite skips -------------------------------------------------


def _read_env_file() -> dict[str, str]:
    """Load .env at repo root if present; helps local devs run pytest directly."""

    env_path = REPO_ROOT / ".env"
    if not env_path.exists():
        return {}
    out: dict[str, str] = {}
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def _openrouter_key() -> str | None:
    key = os.environ.get("OPENROUTER_API_KEY") or os.environ.get("OPEN_ROUTER_API_KEY")
    if key:
        return key
    env_file = _read_env_file()
    return env_file.get("OPENROUTER_API_KEY") or env_file.get("OPEN_ROUTER_API_KEY")


def _have_hermes_agent() -> bool:
    for module_name in ("run_agent", "hermes_agent.run_agent", "hermes_agent"):
        try:
            mod = __import__(module_name, fromlist=["AIAgent"])
        except Exception:  # noqa: BLE001
            continue
        if hasattr(mod, "AIAgent"):
            return True
    return False


pytestmark = pytest.mark.asyncio


@pytest.fixture(scope="module")
def openrouter_key() -> str:
    key = _openrouter_key()
    if not key:
        pytest.skip(
            "OPEN_ROUTER_API_KEY / OPENROUTER_API_KEY missing — add to .env at repo root."
        )
    os.environ.setdefault("OPENROUTER_API_KEY", key)
    return key


@pytest.fixture(scope="module")
def hermes_installed() -> None:
    if not _have_hermes_agent():
        pytest.skip(
            "hermes-agent not installed. Run: "
            "(cd packages/skill && pip install -e '.[hermes]')"
        )


# ---- postgres + schema --------------------------------------------------


@pytest.fixture(scope="module")
def pg_container():
    """Yield (container_or_None, admin_dsn).

    Two paths:
      * ``HEARME_E2E_PG_DSN`` set: skip the container and use that DSN. CI
        uses this to point at a GH Actions service Postgres.
      * Otherwise: start an ephemeral Postgres via testcontainers. Useful
        for local runs; skipped cleanly if Docker isn't available.
    """

    preset_dsn = os.environ.get("HEARME_E2E_PG_DSN")
    if preset_dsn:
        # Schema + roles already applied by the workflow; just yield.
        yield None, preset_dsn
        return

    try:
        from testcontainers.postgres import PostgresContainer  # type: ignore
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"testcontainers not available: {exc}")

    try:
        container = PostgresContainer("postgres:16")
        container.start()
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"could not start postgres container (docker running?): {exc}")

    try:
        # Apply schema then roles as the admin user.
        admin_dsn = container.get_connection_url().replace(
            "postgresql+psycopg2://", "postgres://"
        )

        async def _apply():
            import asyncpg

            conn = await asyncpg.connect(dsn=admin_dsn)
            try:
                await conn.execute(SCHEMA_SQL.read_text())
                await conn.execute(ROLES_SQL.read_text())
            finally:
                await conn.close()

        asyncio.run(_apply())
        yield container, admin_dsn
    finally:
        container.stop()


# ---- broker subprocess --------------------------------------------------


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest.fixture(scope="module")
def broker_process(pg_container):
    """Launch the broker as a subprocess against the testcontainer Postgres."""

    _container, admin_dsn = pg_container
    # broker connects as hearme_broker, not hearme_admin
    broker_dsn = admin_dsn
    # admin_dsn looks like postgres://test:test@127.0.0.1:PORT/test
    # Rewrite to the broker role.
    from urllib.parse import urlparse, urlunparse

    parsed = urlparse(admin_dsn)
    broker_netloc = f"hearme_broker:hearme_broker_dev@{parsed.hostname}:{parsed.port}"
    broker_dsn = urlunparse(parsed._replace(netloc=broker_netloc))

    port = _free_port()
    env = os.environ.copy()
    env["HEARME_BROKER_DATABASE_URL"] = broker_dsn
    env["HEARME_BROKER_EXPOSE_REJECTION_REASONS"] = "True"

    proc = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "hearme_broker.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--log-level",
            "warning",
        ],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )

    base_url = f"http://127.0.0.1:{port}"
    deadline = time.monotonic() + 30.0
    last_err: Exception | None = None
    while time.monotonic() < deadline:
        try:
            with httpx.Client() as c:
                r = c.get(f"{base_url}/healthz", timeout=1.0)
                if r.status_code == 200:
                    break
        except Exception as exc:  # noqa: BLE001
            last_err = exc
        if proc.poll() is not None:
            out = proc.stdout.read().decode() if proc.stdout else ""
            pytest.fail(f"broker exited early: {out}")
        time.sleep(0.3)
    else:
        proc.terminate()
        out = proc.stdout.read().decode() if proc.stdout else ""
        pytest.fail(f"broker never became healthy: {last_err}\n{out}")

    try:
        yield base_url, broker_dsn, admin_dsn
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


# ---- the skill, configured for a single iteration -----------------------


@pytest.fixture
def tmp_skill_root(tmp_path, monkeypatch):
    """Isolate skill on-disk state from any user/dev install.

    Also writes a fresh ``config.yaml`` under ``HERMES_HOME`` selecting
    the ``holographic`` memory provider with ``auto_extract: true``.
    That provider:

    * is SQLite-backed (no external API keys);
    * is the only one ``discover_memory_providers()`` flags available
      on a stock ``hermes-agent`` install;
    * implements ``prefetch(query)`` — Hermes calls this before every
      LLM turn and splices the result into the system prompt, so we
      never need to replay raw chat history.

    The point of the test is to prove the persistent-memory path, so
    we configure persistent memory deliberately rather than letting
    the user's ambient ``~/.hermes/config.yaml`` decide.
    """

    root = tmp_path / "hearme-skill-root"
    root.mkdir()
    monkeypatch.setenv("HEARME_SKILL_ROOT_DIR", str(root))
    monkeypatch.setenv("HEARME_SKILL_POLL_INTERVAL_SECONDS", "1")

    hermes_home = tmp_path / "hermes-home"
    hermes_home.mkdir(parents=True, exist_ok=True)
    (hermes_home / "config.yaml").write_text(
        "memory:\n"
        "  provider: holographic\n"
        "plugins:\n"
        "  hermes-memory-store:\n"
        "    auto_extract: true\n"
        "    default_trust: 0.7\n"
        "    min_trust_threshold: 0.3\n"
    )
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    return root


def _mint_delegation(skill_root: Path) -> None:
    """Install a DelegationToken from a captured zkPassport bridge result.

    After the SNARK migration there is no way to fabricate a valid proof: the
    broker re-verifies it via the zkpassport-bridge. To run this end-to-end
    flow, capture a verified ``GET /requests/<id>`` response (scan a mock
    passport in devMode) whose bundle is bound to THIS skill's agent key, then
    point ``HEARME_E2E_ZK_FIXTURE`` at it. Without that, skip.
    """

    import json as _json

    from hearme_skill.crypto.keystore import load_or_create_agent_keypair
    from hearme_skill.onboarding import accept_delegation_from_mock_phone

    fixture = os.environ.get("HEARME_E2E_ZK_FIXTURE")
    if not fixture or not Path(fixture).exists():
        pytest.skip(
            "HEARME_E2E_ZK_FIXTURE (a captured, verified zkPassport bridge "
            "result bound to the skill agent key) is required for the e2e flow."
        )

    # Load mock-onboard's token builder to convert the bridge result -> token.
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "mock_onboard", REPO_ROOT / "scripts" / "mock-onboard.py"
    )
    assert spec and spec.loader
    mock_onboard = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mock_onboard)

    load_or_create_agent_keypair(skill_root / "agent_key")
    bridge_result = _json.loads(Path(fixture).read_text())
    token = mock_onboard.build_token(bridge_result, ttl_days=90)
    accept_delegation_from_mock_phone(
        raw_json=_json.dumps(token),
        delegation_path=skill_root / "delegation.token",
    )


async def _insert_question(admin_dsn: str, text: str, topic: str = "food") -> uuid.UUID:
    import asyncpg

    qid = uuid.uuid4()
    conn = await asyncpg.connect(dsn=admin_dsn)
    try:
        await conn.execute(
            """
            INSERT INTO questions (id, text, topic, closes_at, status)
            VALUES ($1, $2, $3, $4, 'open')
            """,
            qid,
            text,
            topic,
            datetime.now(timezone.utc) + timedelta(hours=1),
        )
    finally:
        await conn.close()
    return qid


async def _fetch_envelope(admin_dsn: str, question_id: uuid.UUID) -> dict | None:
    import asyncpg

    conn = await asyncpg.connect(dsn=admin_dsn)
    try:
        row = await conn.fetchrow(
            "SELECT answer, disclosed_predicates FROM envelopes WHERE question_id=$1",
            question_id,
        )
    finally:
        await conn.close()
    return dict(row) if row else None


# ---- the test ------------------------------------------------------------


@pytest.mark.slow
async def test_real_hermes_answers_from_prior_conversation(
    hermes_installed,
    openrouter_key,
    broker_process,
    tmp_skill_root,
):
    base_url, _broker_dsn, admin_dsn = broker_process

    # Late import — only after the [hermes] extra check has passed.
    from hearme_skill.llm.hermes_client import HermesLLMClient
    from hearme_skill.memory.hermes_provider import HermesMemoryProvider
    from hearme_skill.skill import answer_one
    from hearme_skill.config import get_settings
    from hearme_skill.ledger import Ledger
    from hearme_skill.broker import BrokerClient
    from hearme_skill.ui import UI, InMemoryChannel
    from hearme_skill.models import Question

    # Step 1: mint a DelegationToken so the broker accepts our envelopes.
    _mint_delegation(tmp_skill_root)

    # Permissive policy so auto-submit fires without a human prompt.
    (tmp_skill_root / "policy.yaml").write_text(
        "auto_answer: true\n"
        "auto_submit_window_seconds: 1\n"
        "max_answers_per_day: 50\n"
        "topic_allowlist: []\n"
        "topic_blocklist: []\n"
    )

    # Step 2: tell Hermes a strong preference, then commit the session
    # so the holographic memory provider's ``on_session_end`` auto-
    # extract regex picks up the "I would never..." sentence and stores
    # the surrounding fact (full content, including "cilantro") for
    # later prefetch (§Mechanism 2 — persistent memory).
    #
    # We deliberately do NOT pass ``conversation_history`` on the
    # answer call; the answer must come back through the prefetch
    # path. Otherwise the test would be silently green via Mechanism 1
    # (history replay), which doesn't scale.
    # Wording is intentional. The holographic provider's auto-extract
    # uses tight regexes — ``I (always|never|usually) X``, ``I
    # (prefer|like|love|use|want|need) X``, ``my (favorite|preferred|
    # default) <noun> is X`` — and stores the surrounding sentence
    # verbatim when one fires. We make sure two of them fire so the
    # extractor stores the cilantro context with high confidence.
    hermes_llm = HermesLLMClient(use_persistent_memory=True)
    hermes_llm.chat(
        "Please remember a few preferences about me. "
        "I never eat cilantro — it tastes like soap to me. "
        "My preferred herb is anything but cilantro. "
        "I hate cilantro and want to avoid it in every dish."
    )
    hermes_llm.commit_memory()

    # Step 3: insert the question into the DB.
    question_id = await _insert_question(
        admin_dsn,
        text="Do you enjoy cilantro in your food? Answer yes or no with one short reason.",
        topic="food",
    )

    # Step 4: drive one iteration of the skill loop. We don't use
    # ``run_loop`` because it would loop forever; ``answer_one`` is the
    # per-question core that does poll/answer/sign/submit-style work
    # given a Question.
    settings = get_settings()
    settings.root_dir.mkdir(parents=True, exist_ok=True)
    ledger = Ledger(settings.ledger_path)
    await ledger.open()
    try:
        memory = HermesMemoryProvider(mode="passthrough")
        ui = UI(channel=InMemoryChannel())
        async with httpx.AsyncClient() as client:
            broker = BrokerClient(
                base_url=base_url,
                client=client,
                ledger=ledger,
                poll_interval_seconds=settings.poll_interval_seconds,
            )

            # Fetch the question through the real broker endpoint so
            # we exercise GET /v1/questions/open end-to-end.
            questions = await broker.poll_questions()
            assert any(str(q.question_id) == str(question_id) for q in questions), (
                f"question {question_id} not visible to broker: "
                f"{[q.question_id for q in questions]}"
            )
            q: Question = next(q for q in questions if str(q.question_id) == str(question_id))

            status = await answer_one(
                q,
                memory=memory,
                llm=hermes_llm,
                ledger=ledger,
                broker=broker,
                ui=ui,
                settings=settings,
            )
    finally:
        await ledger.close()

    assert status == "accepted", f"expected accepted, got {status!r}"

    # Step 5: confirm the envelope landed and the answer is faithful.
    row = await _fetch_envelope(admin_dsn, question_id)
    assert row is not None, "envelope row missing from DB"

    answer_lower = row["answer"].lower()
    # The answer should reflect what we told Hermes. We don't require
    # exact wording (LLMs paraphrase), only that it's *consistent* with
    # disliking cilantro. Use a forgiving disjunction.
    rejects_cilantro = any(
        marker in answer_lower
        for marker in ["no", "hate", "dislike", "don't like", "avoid", "soap"]
    )
    mentions_cilantro = "cilantro" in answer_lower or "coriander" in answer_lower
    assert rejects_cilantro and mentions_cilantro, (
        "Hermes answer does not reflect the prior conversation about cilantro:\n"
        f"  {row['answer']!r}"
    )

    disclosed = (
        json.loads(row["disclosed_predicates"])
        if isinstance(row["disclosed_predicates"], str)
        else row["disclosed_predicates"]
    )
    # mock-phone "standard" profile pre-bakes these — the broker stored
    # them on the envelope per ARCHITECTURE.md §8.5.
    assert "age_band" in disclosed
    assert "region" in disclosed
