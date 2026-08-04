FROM node:22-alpine AS builder
WORKDIR /app
# Pinned exactly, matching CI - an unpinned "pnpm" install pulls
# whatever's newest at build time, which broke the build outright once
# (a self-installer bug in 11.12.0), unrelated to any change in this repo.
RUN npm install -g pnpm@11.7.0

# pnpm runs a deps-status check before any "run"/"exec" script (e.g.
# the "pnpm run build" below) and, on a mismatch, tries to reinstall -
# which needs interactive confirmation to purge node_modules, and a
# Docker build has no TTY to give it. GitHub Actions sets CI=true for
# every workflow automatically (which is why this never showed up
# there), so it must be set explicitly here.
ENV CI=true

COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
COPY frontend/package.json ./frontend/
COPY schloss-ui/package.json ./schloss-ui/

# --filter frontend doesn't spare this image from better-sqlite3 (the
# backend workspace's native dependency) - pnpm's frozen-lockfile install
# still verifies/builds every package in the shared workspace lockfile. Its
# install script downloads a prebuilt binary and only falls back to
# compiling from source (needs Python + a C/C++ toolchain, absent from
# node:22-alpine by default) if that download fails - a transient
# network hiccup then hard-fails the whole build instead of just being
# slower. Installed unconditionally so the rare fallback path works.
RUN apk add --no-cache python3 make g++

# schloss-ui also needs its OWN devDependencies (tsup etc.) installed,
# not just enough for frontend to link against it - "--filter frontend" alone
# only pulls in what frontend needs to use the already-built package, but
# it's no longer pre-built by a separate publish step, so it has to be
# built right here.
RUN pnpm install --frozen-lockfile --filter frontend --filter @zudar107/schloss-ui

# schloss-ui is a git submodule, linked via pnpm's workspace:* protocol -
# still consumed as its built dist/ output (same as when it was a
# registry package), so it needs building here before frontend imports it.
COPY schloss-ui ./schloss-ui
RUN pnpm --filter @zudar107/schloss-ui build

# Vite bakes import.meta.env.VITE_* into the bundle at build time, so this
# must be declared as an ARG to actually receive the value passed via
# docker-compose's build.args.
ARG VITE_ALLOWED_RETURN_ORIGINS=http://localhost:3000,http://localhost:5174
ENV VITE_ALLOWED_RETURN_ORIGINS=$VITE_ALLOWED_RETURN_ORIGINS
ARG VITE_DEFAULT_APP_URL=http://localhost:3000
ENV VITE_DEFAULT_APP_URL=$VITE_DEFAULT_APP_URL

COPY frontend ./frontend
RUN cd frontend && pnpm run build

FROM caddy:2-alpine AS runner
COPY --from=builder /app/frontend/dist /srv
COPY frontend/Caddyfile /etc/caddy/Caddyfile
EXPOSE 80
