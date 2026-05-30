"""Canonical JSON + hashing.

Both packages (skill and broker) must produce byte-identical canonical JSON
for the same dict. Rules:

* UTF-8.
* Keys sorted (recursive).
* No insignificant whitespace (``separators=(",", ":")``).
* ``ensure_ascii=False`` so non-ASCII text is encoded directly (matches the
  broker's verifier and avoids surprising hash mismatches).
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime
from typing import Any


def _default(obj: Any) -> Any:
    if isinstance(obj, datetime):
        # ISO-8601 with 'Z' suffix for UTC. Pydantic uses '+00:00' by default;
        # we normalize here so both the skill and the broker see the same bytes.
        if obj.tzinfo is None:
            return obj.isoformat()
        iso = obj.astimezone().isoformat()
        if iso.endswith("+00:00"):
            iso = iso[:-6] + "Z"
        return iso
    raise TypeError(f"Object of type {type(obj).__name__} is not JSON serializable")


def canonical_json(value: Any) -> str:
    """Return canonical JSON text for `value` (sorted keys, no whitespace)."""

    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        default=_default,
    )


def canonical_json_bytes(value: Any) -> bytes:
    return canonical_json(value).encode("utf-8")


def delegation_hash(token_dict: dict[str, Any]) -> bytes:
    """SHA-256 over canonical_json(delegation_token).

    Pass the dict form (e.g. ``token.model_dump(mode="json")``) so datetime
    fields are already strings.
    """

    return hashlib.sha256(canonical_json_bytes(token_dict)).digest()


def sign_payload(question_id: str, answer: str, nonce: str, delegation_hash_hex: str) -> bytes:
    """Compute H(question_id || answer || nonce || delegation_hash).

    Byte layout MUST match ``hearme_broker.verify.envelope.envelope_signing_input``:
    the four UTF-8 components joined with a single ASCII ``|`` separator, then
    SHA-256'd to a 32-byte digest. ``delegation_hash`` is the hex string form
    (matches the broker's ``delegation_hash`` which returns hex). Any drift
    here causes ``agent_signature_invalid`` rejections at the broker.
    """

    sep = b"|"
    parts = [
        question_id.encode("utf-8"),
        answer.encode("utf-8"),
        nonce.encode("utf-8"),
        delegation_hash_hex.encode("utf-8"),
    ]
    return hashlib.sha256(sep.join(parts)).digest()


def revocation_payload(question_id: str, delegation_hash_hex: str) -> bytes:
    """Compute H("REVOKE" || question_id || delegation_hash).

    Byte layout MUST match ``hearme_broker.verify.envelope.revocation_signing_input``:
    the literal ``REVOKE`` prefix + the two UTF-8 components, joined with a
    single ASCII ``|`` separator, SHA-256'd to 32 bytes. The ``REVOKE`` prefix
    is the domain separator that prevents a captured envelope signature from
    being replayed as a revocation (and vice versa). Any drift here causes
    ``agent_signature_invalid`` rejections at the broker.
    """

    sep = b"|"
    parts = [
        b"REVOKE",
        question_id.encode("utf-8"),
        delegation_hash_hex.encode("utf-8"),
    ]
    return hashlib.sha256(sep.join(parts)).digest()
