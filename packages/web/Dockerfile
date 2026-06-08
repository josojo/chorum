# chorum-web — Next.js 14 App Router.
# Build context: repo root.
FROM node:20-alpine

ENV NEXT_TELEMETRY_DISABLED=1

WORKDIR /app

# Install deps first so the layer caches between source-only edits.
# Deliberately NOT setting NODE_ENV=production yet: that would make npm
# skip devDependencies, and `typescript`, `tailwindcss`, `postcss`, etc.
# all live there. Without `typescript` Next silently disables the `paths`
# alias and the build fails with "Module not found: '@/...'".
COPY packages/web/package.json packages/web/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY packages/web/next.config.mjs ./
COPY packages/web/tsconfig.json ./
COPY packages/web/tailwind.config.ts ./
COPY packages/web/postcss.config.js ./
COPY packages/web/next-env.d.ts ./
COPY packages/web/drizzle.config.ts ./
COPY packages/web/drizzle ./drizzle
COPY packages/web/scripts ./scripts
COPY packages/web/src ./src

# `next build` would prerender the home page, which needs a build-time
# DATABASE_URL; we already mark `/` as `force-dynamic` but Next still
# evaluates the route module. Pass a non-functional placeholder so the
# build succeeds — runtime uses the real DATABASE_URL.
RUN DATABASE_URL=postgres://placeholder:placeholder@localhost:5432/placeholder \
    npx next build

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0

EXPOSE 3000

CMD ["npx", "next", "start", "-H", "0.0.0.0", "-p", "3000"]
