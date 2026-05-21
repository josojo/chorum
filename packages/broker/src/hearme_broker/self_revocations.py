"""Self on-chain invalidation listener.

The broker verifies Self once at registration, so it must also consume Self's
later on-chain invalidation/update signal. This worker polls a configured Self
contract event and applies invalidations inside the broker database:

* mark ``registrations.revoked_at``
* remove accepted envelopes from that nullifier
* recompute affected aggregates

The exact Self event ABI is intentionally configuration, not code: Self's public
docs describe recovery/disabled commitments but do not pin a stable event name
for this integration. Production must set the contract, event topic, and where
the nullifier appears in the log.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Any

import asyncpg
import httpx

from .config import Settings, get_settings
from .db import queries as q

log = logging.getLogger("hearme_broker.self_revocations")


class SelfRevocationConfigError(ValueError):
    """Raised when the listener is enabled without enough chain config."""


def _clean_hex(value: str) -> str:
    if not isinstance(value, str):
        raise ValueError("expected hex string")
    value = value.lower()
    return value if value.startswith("0x") else f"0x{value}"


def _hex_to_int_string(value: str) -> str:
    return str(int(_clean_hex(value), 16))


def nullifier_candidates(raw: str) -> list[str]:
    """Return likely DB forms for a Self nullifier emitted as bytes32/uint256.

    Self SDK outputs have changed shape across docs/examples. The bridge stores
    whatever ``discloseOutput.nullifier`` returns, while chain logs usually emit
    a uint256/bytes32. Matching a small candidate set lets the listener work
    whether the stored value is decimal, 0x-hex, or prefixed with ``self:``.
    """
    h = _clean_hex(raw)
    stripped = "0x" + h[2:].lstrip("0")
    if stripped == "0x":
        stripped = "0x0"
    decimal = _hex_to_int_string(h)
    out = [h, stripped, decimal, f"self:{h}", f"self:{stripped}", f"self:{decimal}"]
    seen: set[str] = set()
    return [x for x in out if not (x in seen or seen.add(x))]


def extract_nullifier_from_log(
    entry: dict[str, Any], *, topic_index: int, data_word_index: int
) -> str | None:
    """Extract a nullifier-like 32-byte value from an eth_getLogs entry."""
    topics = entry.get("topics") or []
    if topic_index >= 0:
        if topic_index >= len(topics):
            return None
        return _clean_hex(topics[topic_index])

    if data_word_index < 0:
        return None
    data = entry.get("data")
    if not isinstance(data, str):
        return None
    body = data[2:] if data.startswith("0x") else data
    start = data_word_index * 64
    word = body[start : start + 64]
    if len(word) != 64:
        return None
    return f"0x{word.lower()}"


@dataclass(frozen=True)
class ChainLog:
    block_number: int
    log_index: int
    tx_hash: str
    nullifier_raw: str


class SelfRevocationListener:
    """Poll Self invalidation logs and apply matching broker revocations."""

    def __init__(
        self,
        *,
        pool: asyncpg.Pool,
        settings: Settings | None = None,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.pool = pool
        self.settings = settings or get_settings()
        self.client = client
        self._own_client = client is None
        self._stop = asyncio.Event()
        self._task: asyncio.Task[None] | None = None

    def validate_config(self) -> None:
        s = self.settings
        if not s.self_revocation_listener_enabled:
            return
        missing = [
            name
            for name, value in {
                "HEARME_BROKER_SELF_REVOCATION_RPC_URL": s.self_revocation_rpc_url,
                "HEARME_BROKER_SELF_REVOCATION_CONTRACT_ADDRESS": s.self_revocation_contract_address,
                "HEARME_BROKER_SELF_REVOCATION_EVENT_TOPIC": s.self_revocation_event_topic,
            }.items()
            if not value
        ]
        if missing:
            raise SelfRevocationConfigError(
                "Self revocation listener enabled but missing " + ", ".join(missing)
            )
        if (
            s.self_revocation_nullifier_topic_index < 0
            and s.self_revocation_nullifier_data_word_index < 0
        ):
            raise SelfRevocationConfigError(
                "configure either nullifier_topic_index or nullifier_data_word_index"
            )

    def start(self) -> None:
        self.validate_config()
        if not self.settings.self_revocation_listener_enabled:
            log.info("Self revocation listener disabled")
            return
        if self._task is None:
            self._task = asyncio.create_task(self.run(), name="self-revocation-listener")

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            await self._task
        if self._own_client and self.client is not None:
            await self.client.aclose()

    async def _rpc(self, method: str, params: list[Any]) -> Any:
        if self.client is None:
            self.client = httpx.AsyncClient(timeout=30.0)
        resp = await self.client.post(
            self.settings.self_revocation_rpc_url,
            json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
        )
        resp.raise_for_status()
        body = resp.json()
        if body.get("error"):
            raise RuntimeError(f"{method} failed: {body['error']}")
        return body.get("result")

    async def latest_final_block(self) -> int:
        head_hex = await self._rpc("eth_blockNumber", [])
        head = int(head_hex, 16)
        return max(0, head - max(0, self.settings.self_revocation_confirmations))

    async def fetch_logs(self, *, from_block: int, to_block: int) -> list[ChainLog]:
        s = self.settings
        result = await self._rpc(
            "eth_getLogs",
            [
                {
                    "fromBlock": hex(from_block),
                    "toBlock": hex(to_block),
                    "address": s.self_revocation_contract_address,
                    "topics": [_clean_hex(s.self_revocation_event_topic)],
                }
            ],
        )
        logs: list[ChainLog] = []
        for entry in result or []:
            raw = extract_nullifier_from_log(
                entry,
                topic_index=s.self_revocation_nullifier_topic_index,
                data_word_index=s.self_revocation_nullifier_data_word_index,
            )
            if raw is None:
                log.warning("Self invalidation log without configured nullifier: %s", entry)
                continue
            logs.append(
                ChainLog(
                    block_number=int(entry["blockNumber"], 16),
                    log_index=int(entry["logIndex"], 16),
                    tx_hash=str(entry["transactionHash"]),
                    nullifier_raw=raw,
                )
            )
        logs.sort(key=lambda item: (item.block_number, item.log_index))
        return logs

    async def apply_log(self, item: ChainLog) -> dict[str, Any] | None:
        candidates = nullifier_candidates(item.nullifier_raw)
        async with self.pool.acquire() as conn:
            result = await q.invalidate_first_matching_registration_and_votes(
                conn,
                candidates=candidates,
                source="self_onchain",
                chain_id=self.settings.self_revocation_chain_id,
                block_number=item.block_number,
                log_index=item.log_index,
                tx_hash=item.tx_hash,
            )
        if result is not None:
            log.info(
                "applied Self invalidation block=%s log=%s envelopes=%s questions=%s",
                item.block_number,
                item.log_index,
                result["deleted_envelopes"],
                result["affected_questions"],
            )
        return result

    async def poll_once(self) -> int:
        s = self.settings
        async with self.pool.acquire() as conn:
            cursor = await q.get_self_chain_cursor(conn, s.self_revocation_cursor_name)
        from_block = (cursor + 1) if cursor is not None else s.self_revocation_from_block
        to_block = await self.latest_final_block()
        if to_block < from_block:
            return 0

        logs = await self.fetch_logs(from_block=from_block, to_block=to_block)
        for item in logs:
            await self.apply_log(item)

        async with self.pool.acquire() as conn:
            await q.upsert_self_chain_cursor(
                conn,
                name=s.self_revocation_cursor_name,
                last_block=to_block,
            )
        return len(logs)

    async def run(self) -> None:
        log.info("Self revocation listener started")
        while not self._stop.is_set():
            try:
                count = await self.poll_once()
                if count:
                    log.info("processed %s Self invalidation log(s)", count)
            except Exception:
                log.exception("Self revocation listener poll failed")
            try:
                await asyncio.wait_for(
                    self._stop.wait(),
                    timeout=self.settings.self_revocation_poll_interval_seconds,
                )
            except asyncio.TimeoutError:
                pass
        log.info("Self revocation listener stopped")
