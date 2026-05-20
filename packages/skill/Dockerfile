# hearme-skill — Python 3.11 + pynacl + httpx + aiosqlite.
# Build context: repo root.
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    HEARME_SKILL_ROOT_DIR=/data \
    HEARME_SKILL_BROKER_URL=http://broker:8000

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends libsodium23 \
    && rm -rf /var/lib/apt/lists/*

COPY packages/skill/pyproject.toml ./pyproject.toml
COPY packages/skill/src ./src
COPY packages/skill/README.md ./README.md

RUN pip install --upgrade pip && pip install .

# mock-onboard.py is part of the repo, not the skill package; copy it in so the
# entrypoint can replay a captured dev-mode proof fixture into a DelegationToken.
COPY scripts/mock-onboard.py /usr/local/bin/mock-onboard.py
COPY packages/skill/docker-entrypoint.sh /usr/local/bin/hearme-skill-entrypoint
RUN chmod +x /usr/local/bin/mock-onboard.py /usr/local/bin/hearme-skill-entrypoint

VOLUME ["/data"]

ENTRYPOINT ["/usr/local/bin/hearme-skill-entrypoint"]
