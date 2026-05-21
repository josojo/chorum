# Build context is the repo root (matches packages/broker + packages/web).
FROM node:22-slim

WORKDIR /app

COPY packages/self-bridge/package.json ./
RUN npm install --omit=dev

COPY packages/self-bridge/src ./src

ENV PORT=8787

EXPOSE 8787

CMD ["node", "src/server.js"]
