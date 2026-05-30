"""Channel — § 7.1.

Polls ``GET /v1/questions/open?since=<last_seen>`` every `poll_interval_seconds`
and submits envelopes to ``POST /v1/envelopes``. Backoff + retry + replay-safe.
No business logic — this layer is dumb pipes.

Persists `last_seen` to the ledger so the cursor survives restarts (§1.9).
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass

import httpx

from .ledger import Ledger
from .models import Envelope, Question

log = logging.getLogger(__name__)


@dataclass
class BrokerClient:
    base_url: str
    client: httpx.AsyncClient
    ledger: Ledger
    poll_interval_seconds: float = 30.0
    # Cap so a long outage doesn't push retries into minutes.
    max_backoff_seconds: float = 300.0

    async def poll_questions(self) -> list[Question]:
        """One poll cycle. Returns the new questions; persists the cursor.

        Cursor advances to the maximum broker-supplied ``created_at`` from
        the returned questions. That keeps polling independent of local host
        clock skew. Idempotence is preserved at the per-question layer via
        ``Ledger.has_submission`` (§1.9).
        """

        since = await self.ledger.last_seen_cursor()
        params = {"since": since} if since else {}
        try:
            resp = await self.client.get(
                f"{self.base_url}/v1/questions/open", params=params, timeout=15.0
            )
        except httpx.HTTPError as exc:
            log.warning("broker poll failed: %s", exc)
            return []
        if resp.status_code != 200:
            log.warning("broker poll non-200: %s", resp.status_code)
            return []
        raw = resp.json()
        questions = [Question.model_validate(q) for q in raw]
        if questions:
            latest_created_at = max(q.created_at for q in questions)
            await self.ledger.set_last_seen(latest_created_at.isoformat())
        return questions

    async def submit_envelope(self, envelope: Envelope) -> tuple[bool, str]:
        """POST /v1/envelopes. Returns (accepted, reason).

        §1.9 idempotent: callers must check the ledger before invoking;
        this method does not deduplicate by itself.
        """

        body = envelope.model_dump(mode="json")
        # Defensive: confirm only the five canonical fields go on the wire.
        expected = {"question_id", "answer", "nonce", "delegation_token", "agent_signature"}
        if set(body.keys()) != expected:
            raise RuntimeError(
                f"refusing to submit envelope with non-canonical fields: {set(body.keys())}"
            )

        backoff = 1.0
        for attempt in range(5):
            try:
                resp = await self.client.post(
                    f"{self.base_url}/v1/envelopes", json=body, timeout=20.0
                )
            except httpx.HTTPError as exc:
                log.warning("submit attempt %s failed: %s", attempt, exc)
                await asyncio.sleep(min(backoff, self.max_backoff_seconds))
                backoff *= 2
                continue
            if resp.status_code in (200, 201):
                payload = resp.json()
                return bool(payload.get("accepted")), str(payload.get("reason", ""))
            if 500 <= resp.status_code < 600:
                await asyncio.sleep(min(backoff, self.max_backoff_seconds))
                backoff *= 2
                continue
            # 4xx: deterministic rejection. Do not retry.
            try:
                payload = resp.json()
                return False, str(payload.get("reason", f"HTTP {resp.status_code}"))
            except ValueError:
                return False, f"HTTP {resp.status_code}"
        return False, "max retries exhausted"

    async def submit_revocation(self, body: dict) -> tuple[bool, str]:
        """POST /v1/envelopes/revoke (§1.12). Returns (accepted, reason).

        ``body`` is the three-field dict from ``envelope.build_revocation``.
        Idempotent at the broker: revoking an answer that was never submitted
        returns ``accepted=True, reason="envelope_not_found"``, so callers
        treat ``accepted`` as the authoritative outcome.
        """

        expected = {"question_id", "delegation_token", "revocation_signature"}
        if set(body.keys()) != expected:
            raise RuntimeError(
                f"refusing to submit revocation with non-canonical fields: {set(body.keys())}"
            )

        backoff = 1.0
        for attempt in range(5):
            try:
                resp = await self.client.post(
                    f"{self.base_url}/v1/envelopes/revoke", json=body, timeout=20.0
                )
            except httpx.HTTPError as exc:
                log.warning("revoke attempt %s failed: %s", attempt, exc)
                await asyncio.sleep(min(backoff, self.max_backoff_seconds))
                backoff *= 2
                continue
            if resp.status_code in (200, 201):
                payload = resp.json()
                return bool(payload.get("accepted")), str(payload.get("reason", "") or "")
            if 500 <= resp.status_code < 600:
                await asyncio.sleep(min(backoff, self.max_backoff_seconds))
                backoff *= 2
                continue
            try:
                payload = resp.json()
                return False, str(payload.get("reason", f"HTTP {resp.status_code}"))
            except ValueError:
                return False, f"HTTP {resp.status_code}"
        return False, "max retries exhausted"
