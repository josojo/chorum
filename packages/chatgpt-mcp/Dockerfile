FROM rust:1.82-slim AS signer-build
WORKDIR /src
COPY packages/skill/Cargo.toml packages/skill/Cargo.lock ./packages/skill/
COPY packages/skill ./packages/skill
RUN cargo build --manifest-path packages/skill/Cargo.toml --release

FROM node:20-slim
WORKDIR /app
COPY packages/chatgpt-mcp/package.json packages/chatgpt-mcp/package-lock.json ./
RUN npm ci --omit=dev
COPY packages/chatgpt-mcp/tsconfig.json ./
COPY packages/chatgpt-mcp/src ./src
COPY --from=signer-build /src/packages/skill/target/release/chorum-skill /usr/local/bin/chorum-skill
RUN npx tsc --noEmit false --outDir dist --module NodeNext --target ES2022 --moduleResolution NodeNext

ENV NODE_ENV=production
EXPOSE 8788
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=10 \
  CMD node -e "fetch('http://localhost:8788/mcp/healthz').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/src/main.js"]
