"""Postgres access — asyncpg pool + parameterized queries.

The broker connects as the ``hearme_broker`` Postgres role, which can only
write ``envelopes``, ``aggregates``, ``revocations``. See db/init/02-roles.sh.
"""

from .client import close_pool, get_pool, init_pool

__all__ = ["close_pool", "get_pool", "init_pool"]
