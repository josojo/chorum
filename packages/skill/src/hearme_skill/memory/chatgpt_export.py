"""Local memory provider backed by a user-supplied ChatGPT data export.

This module deliberately does not try to read the running ChatGPT macOS app.
The supported path is explicit user export -> local import -> local SQLite FTS
lookup. The resulting database stays on the user's machine and implements the
same ``MemoryProvider`` contract as the Hermes and stub providers.
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import zipfile
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from .provider import MemoryQuery, MemorySnapshot


_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z0-9_+-]{2,}")
_WS_RE = re.compile(r"\s+")


@dataclass(frozen=True)
class ImportStats:
    conversations: int
    chunks: int
    db_path: Path


@dataclass(frozen=True)
class _Chunk:
    conversation_id: str
    title: str
    role: str
    created_at: float | None
    text: str


class ChatGPTExportMemoryProvider:
    """SQLite FTS-backed provider for imported ChatGPT conversations."""

    name = "chatgpt-export"

    def __init__(self, db_path: Path | str) -> None:
        self.db_path = Path(db_path).expanduser()

    def query(self, q: MemoryQuery) -> MemorySnapshot:
        if not self.db_path.exists():
            return MemorySnapshot(facts=(), style_hints=("plain", "concise"))

        terms = _query_terms(q)
        if not terms:
            return MemorySnapshot(facts=(), style_hints=("plain", "concise"))

        with sqlite3.connect(self.db_path) as conn:
            rows = _search(conn, terms, limit=max(q.limit * 3, q.limit))

        facts: list[str] = []
        seen: set[str] = set()
        for title, role, text in rows:
            fact = _fact_from_chunk(title=title, role=role, text=text, terms=terms)
            if not fact:
                continue
            key = fact.lower()
            if key in seen:
                continue
            facts.append(fact)
            seen.add(key)
            if len(facts) >= q.limit:
                break

        return MemorySnapshot(
            facts=tuple(facts),
            style_hints=("grounded in prior ChatGPT chats", "plain", "concise"),
        )


def import_chatgpt_export(
    export_path: Path | str,
    *,
    db_path: Path | str,
    include_assistant: bool = False,
) -> ImportStats:
    """Import a ChatGPT data export into a local SQLite FTS database."""

    source = Path(export_path).expanduser()
    dest = Path(db_path).expanduser()
    dest.parent.mkdir(parents=True, exist_ok=True)

    conversations = _load_conversations(source)
    chunks = list(_iter_chunks(conversations, include_assistant=include_assistant))

    with sqlite3.connect(dest) as conn:
        _init_db(conn)
        conn.execute("DELETE FROM chunks")
        conn.execute("DELETE FROM chunks_fts")
        for chunk in chunks:
            cur = conn.execute(
                """
                INSERT INTO chunks(conversation_id, title, role, created_at, text)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    chunk.conversation_id,
                    chunk.title,
                    chunk.role,
                    chunk.created_at,
                    chunk.text,
                ),
            )
            conn.execute(
                "INSERT INTO chunks_fts(rowid, title, text) VALUES (?, ?, ?)",
                (cur.lastrowid, chunk.title, chunk.text),
            )
        conn.commit()

    return ImportStats(conversations=len(conversations), chunks=len(chunks), db_path=dest)


def cli(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="hearme-chatgpt-memory")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_import = sub.add_parser(
        "import",
        help="Import a downloaded ChatGPT export ZIP, directory, or conversations.json",
    )
    p_import.add_argument("export_path")
    p_import.add_argument("--db", required=True, help="Destination SQLite memory DB")
    p_import.add_argument(
        "--include-assistant",
        action="store_true",
        help="Also index assistant replies. Default indexes only user-authored messages.",
    )
    p_import.set_defaults(func=_cmd_import)

    p_query = sub.add_parser("query", help="Query an imported ChatGPT memory DB")
    p_query.add_argument("text")
    p_query.add_argument("--db", required=True, help="SQLite memory DB")
    p_query.add_argument("--topic", default=None)
    p_query.add_argument("--limit", type=int, default=5)
    p_query.set_defaults(func=_cmd_query)

    args = parser.parse_args(argv)
    return args.func(args)


def _cmd_import(args: argparse.Namespace) -> int:
    stats = import_chatgpt_export(
        args.export_path,
        db_path=args.db,
        include_assistant=args.include_assistant,
    )
    print(
        f"Imported {stats.conversations} conversations and {stats.chunks} "
        f"message chunks into {stats.db_path}"
    )
    return 0


def _cmd_query(args: argparse.Namespace) -> int:
    provider = ChatGPTExportMemoryProvider(args.db)
    snapshot = provider.query(MemoryQuery(topic=args.topic, text=args.text, limit=args.limit))
    for fact in snapshot.facts:
        print(f"- {fact}")
    return 0


def _load_conversations(path: Path) -> list[dict[str, Any]]:
    if path.is_file() and path.suffix.lower() == ".zip":
        with TemporaryDirectory() as tmp:
            with zipfile.ZipFile(path) as zf:
                zf.extractall(tmp)
            return _load_conversations(Path(tmp))

    if path.is_dir():
        candidates = [path / "conversations.json", *path.glob("**/conversations.json")]
        for candidate in candidates:
            if candidate.exists():
                return _load_conversations(candidate)
        raise FileNotFoundError(f"no conversations.json found under {path}")

    with path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, list):
        raise ValueError("ChatGPT conversations export must be a JSON list")
    return data


def _iter_chunks(
    conversations: Iterable[dict[str, Any]],
    *,
    include_assistant: bool,
) -> Iterable[_Chunk]:
    allowed_roles = {"user", "tool"} if not include_assistant else {"user", "assistant", "tool"}
    for idx, conv in enumerate(conversations):
        conv_id = str(conv.get("id") or idx)
        title = _clean_title(str(conv.get("title") or "Untitled ChatGPT chat"))
        mapping = conv.get("mapping") or {}
        if not isinstance(mapping, dict):
            continue
        messages: list[tuple[float, dict[str, Any]]] = []
        for node in mapping.values():
            if not isinstance(node, dict):
                continue
            msg = node.get("message")
            if isinstance(msg, dict):
                created_at = msg.get("create_time") or 0.0
                messages.append((float(created_at or 0.0), msg))
        for _, msg in sorted(messages, key=lambda item: item[0]):
            role = ((msg.get("author") or {}).get("role") or "").lower()
            if role not in allowed_roles:
                continue
            text = _message_text(msg)
            if not text:
                continue
            for part in _chunk_text(text):
                yield _Chunk(
                    conversation_id=conv_id,
                    title=title,
                    role=role,
                    created_at=msg.get("create_time"),
                    text=part,
                )


def _message_text(msg: dict[str, Any]) -> str:
    content = msg.get("content") or {}
    parts = content.get("parts") or []
    out: list[str] = []
    for part in parts:
        if isinstance(part, str):
            out.append(part)
        elif isinstance(part, dict):
            text = part.get("text")
            if isinstance(text, str):
                out.append(text)
    return _clean_text("\n".join(out))


def _chunk_text(text: str, *, max_chars: int = 900) -> Iterable[str]:
    if len(text) <= max_chars:
        yield text
        return
    sentences = re.split(r"(?<=[.!?])\s+", text)
    buf = ""
    for sentence in sentences:
        if len(buf) + len(sentence) + 1 > max_chars and buf:
            yield buf.strip()
            buf = sentence
        else:
            buf = f"{buf} {sentence}".strip()
    if buf:
        yield buf.strip()


def _init_db(conn: sqlite3.Connection) -> None:
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS chunks (
            id INTEGER PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            title TEXT NOT NULL,
            role TEXT NOT NULL,
            created_at REAL,
            text TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
        USING fts5(title, text, content='chunks', content_rowid='id')
        """
    )


def _search(conn: sqlite3.Connection, terms: list[str], *, limit: int) -> list[tuple[str, str, str]]:
    match = " OR ".join(_escape_fts_term(term) for term in terms[:8])
    try:
        return list(
            conn.execute(
                """
                SELECT chunks.title, chunks.role, chunks.text
                FROM chunks_fts
                JOIN chunks ON chunks.id = chunks_fts.rowid
                WHERE chunks_fts MATCH ?
                ORDER BY bm25(chunks_fts)
                LIMIT ?
                """,
                (match, limit),
            )
        )
    except sqlite3.OperationalError:
        like_terms = [f"%{term}%" for term in terms[:4]]
        clauses = " OR ".join(["text LIKE ?"] * len(like_terms))
        return list(
            conn.execute(
                f"SELECT title, role, text FROM chunks WHERE {clauses} LIMIT ?",
                (*like_terms, limit),
            )
        )


def _query_terms(q: MemoryQuery) -> list[str]:
    tokens = _TOKEN_RE.findall(f"{q.topic or ''} {q.text}".lower())
    stop = {
        "about",
        "after",
        "before",
        "does",
        "have",
        "should",
        "that",
        "this",
        "what",
        "when",
        "where",
        "which",
        "with",
        "would",
        "your",
    }
    out: list[str] = []
    for token in tokens:
        if token in stop or token in out:
            continue
        out.append(token)
    return out[:12]


def _fact_from_chunk(
    *,
    title: str,
    role: str,
    text: str,
    terms: list[str],
    max_chars: int = 220,
) -> str | None:
    snippet = _best_window(text, terms, max_chars=max_chars)
    if not snippet:
        return None
    actor = "user" if role == "user" else role
    return f"Prior ChatGPT chat '{title}' has a {actor} note relevant here: {snippet}"


def _best_window(text: str, terms: list[str], *, max_chars: int) -> str:
    clean = _clean_text(text)
    lowered = clean.lower()
    positions = [lowered.find(term.lower()) for term in terms if lowered.find(term.lower()) >= 0]
    if not positions:
        return _truncate(clean, max_chars)
    start = max(min(positions) - 60, 0)
    end = min(start + max_chars, len(clean))
    return _truncate(clean[start:end].strip(" ,.;:\n"), max_chars)


def _clean_title(text: str) -> str:
    cleaned = _clean_text(text)
    return _truncate(cleaned, 80) or "Untitled ChatGPT chat"


def _clean_text(text: str) -> str:
    return _WS_RE.sub(" ", text.replace("\x00", " ")).strip()


def _truncate(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 1].rstrip() + "..."


def _escape_fts_term(term: str) -> str:
    return '"' + term.replace('"', '""') + '"'

