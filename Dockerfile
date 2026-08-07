FROM node:22-alpine AS builder

# Pinned exactly, matching CI - "pnpm@latest" pulled whatever pnpm
# published most recently, which broke the build outright once (a
# self-installer bug in 11.12.0), unrelated to any change in this repo.
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate
WORKDIR /app

# pnpm runs a deps-status check before any "run"/"exec" script (e.g.
# the "pnpm build" below) and, on a mismatch, tries to reinstall -
# which needs interactive confirmation to purge node_modules, and a
# Docker build has no TTY to give it. GitHub Actions sets CI=true for
# every workflow automatically (which is why this never showed up
# there), so it must be set explicitly here.
ENV CI=true

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY schloss-server-kit/package.json ./schloss-server-kit/
COPY schloss-ui/package.json ./schloss-ui/

# better-sqlite3's install script downloads a prebuilt binary and only
# falls back to compiling from source (needs Python + a C/C++
# toolchain, absent from node:22-alpine by default) if that download
# fails - a transient network hiccup then hard-fails the whole build
# instead of just being slower. Installed unconditionally so the rare
# fallback path works instead of erroring out.
RUN apk add --no-cache python3 make g++

# pnpm's frozen-lockfile install verifies/resolves every package in the
# lockfile, not just this project's own deps, even with --filter -
# since frontend's @zudar107/schloss-ui is part of the same workspace
# lockfile, its package.json (copied above) needs to be present for
# this to resolve, despite never using the package itself. No registry
# involved (it's a workspace:* link to the schloss-ui submodule), so
# no auth needed either.
RUN pnpm install --frozen-lockfile

COPY tsconfig.json drizzle.config.ts ./
COPY schloss-server-kit ./schloss-server-kit
COPY src ./src
RUN pnpm build

# ---

FROM node:22-alpine AS runner

RUN corepack enable && corepack prepare pnpm@11.7.0 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY schloss-server-kit/package.json ./schloss-server-kit/
COPY schloss-ui/package.json ./schloss-ui/
# See the builder stage's comment above - same fallback-compile issue.
RUN apk add --no-cache python3 make g++
RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/schloss-server-kit/dist ./schloss-server-kit/dist
COPY src/db/migrations ./dist/db/migrations

RUN mkdir -p /data/keys

ENV NODE_ENV=production \
    DATABASE_PATH=/data/schlussel.db \
    KEYS_DIR=/data/keys \
    PORT=4000

EXPOSE 4000

CMD ["node", "dist/index.js"]
