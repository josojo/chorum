from __future__ import annotations

import json
import zipfile

from hearme_skill.memory.chatgpt_export import (
    ChatGPTExportMemoryProvider,
    import_chatgpt_export,
)
from hearme_skill.memory.provider import MemoryQuery


def _conversation_export():
    return [
        {
            "id": "conv-1",
            "title": "Coffee preferences",
            "mapping": {
                "root": {"message": None},
                "u1": {
                    "message": {
                        "author": {"role": "user"},
                        "create_time": 1710000000.0,
                        "content": {
                            "content_type": "text",
                            "parts": [
                                "Please remember that I prefer washed Ethiopian coffee "
                                "and avoid espresso after lunch."
                            ],
                        },
                    }
                },
                "a1": {
                    "message": {
                        "author": {"role": "assistant"},
                        "create_time": 1710000001.0,
                        "content": {
                            "content_type": "text",
                            "parts": ["Got it."],
                        },
                    }
                },
            },
        }
    ]


def test_imports_conversations_json_and_queries_user_messages(tmp_path):
    export = tmp_path / "conversations.json"
    export.write_text(json.dumps(_conversation_export()), encoding="utf-8")
    db = tmp_path / "memory.sqlite"

    stats = import_chatgpt_export(export, db_path=db)
    assert stats.conversations == 1
    assert stats.chunks == 1

    provider = ChatGPTExportMemoryProvider(db)
    snapshot = provider.query(MemoryQuery(topic="coffee", text="Do I like espresso?", limit=3))

    assert snapshot.facts
    assert "Coffee preferences" in snapshot.facts[0]
    assert "espresso after lunch" in snapshot.facts[0]


def test_imports_zip_export(tmp_path):
    zip_path = tmp_path / "chatgpt-export.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("conversations.json", json.dumps(_conversation_export()))
    db = tmp_path / "memory.sqlite"

    stats = import_chatgpt_export(zip_path, db_path=db)
    assert stats.chunks == 1


def test_assistant_messages_are_opt_in(tmp_path):
    export = tmp_path / "conversations.json"
    export.write_text(json.dumps(_conversation_export()), encoding="utf-8")
    db = tmp_path / "memory.sqlite"

    import_chatgpt_export(export, db_path=db)
    provider = ChatGPTExportMemoryProvider(db)
    snapshot = provider.query(MemoryQuery(topic=None, text="Got it", limit=3))

    assert snapshot.facts == ()
