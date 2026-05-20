# Build context is the repo root (matches packages/broker + packages/web).
# @zkpassport/sdk requires Node >= 22.
FROM node:22-slim

WORKDIR /app

COPY packages/zkpassport-bridge/package.json ./
RUN npm install --omit=dev

COPY packages/zkpassport-bridge/src ./src

ENV PORT=8787 \
    ZKPASSPORT_WRITING_DIR=/tmp

EXPOSE 8787

CMD ["node", "src/server.js"]
