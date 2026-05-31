# hearme-broker — Node 20 + Fastify + Drizzle (postgres-js) + tweetnacl.
# Build context: repo root (docker-compose sets `context: .`).
#
# The broker reuses the Drizzle schema from packages/web/src/db/schema.ts (the
# single source of truth). To make that relative import resolve — and to give it
# and the broker source ONE shared drizzle-orm — we install dependencies at /app
# (a common ancestor) and lay the sources out mirroring the monorepo. tsup then
# bundles src + the reused schema into a self-contained dist/.
FROM node:20-slim

WORKDIR /app

# Hoisted install at /app so node_modules is an ancestor of BOTH the broker
# source and packages/web/src/db/schema.ts (whose drizzle-orm import must
# resolve during the tsup bundle).
COPY packages/broker/package.json packages/broker/package-lock.json packages/broker/.npmrc ./
RUN npm ci

# Lay out sources to mirror the monorepo (../../web/src/db/schema resolves).
COPY packages/broker ./packages/broker
COPY packages/web/src/db/schema.ts ./packages/web/src/db/schema.ts

WORKDIR /app/packages/broker
RUN npm run build

ENV NODE_ENV=production

EXPOSE 8000

HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=10 \
    CMD node -e "fetch('http://localhost:8000/healthz').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
