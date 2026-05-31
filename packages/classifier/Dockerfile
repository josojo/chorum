# Build context is the repo root (matches packages/broker + packages/web).
#
# Multi-stage: install deps + compile TS in a builder, then ship just the
# compiled JS + node_modules in a slim runtime image.

FROM node:22-slim AS builder
WORKDIR /app
COPY packages/classifier/package.json packages/classifier/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY packages/classifier/tsconfig.json ./
COPY packages/classifier/src ./src
RUN npx tsc -p tsconfig.json

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY packages/classifier/package.json packages/classifier/package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=builder /app/dist ./dist

# Drop privileges. The node:slim image already has a non-root `node` user.
USER node

CMD ["node", "dist/index.js"]
