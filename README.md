# Schlüssel

[![Test](https://github.com/zudaR107/schlussel/actions/workflows/test.yml/badge.svg)](https://github.com/zudaR107/schlussel/actions/workflows/test.yml)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)

Part of the [Hof platform](https://github.com/zudaR107/Hof) — a suite of
self-hosted personal services:

- [`schloss`](https://github.com/zudaR107/schloss) — home page / launcher
- **`schlussel`** (this repo) — auth: accounts, login, tokens
- [`kuvert`](https://github.com/zudaR107/kuvert) — envelope budgeting
- [`tafel`](https://github.com/zudaR107/tafel) — task/project tracking
- [`tor`](https://github.com/zudaR107/tor) — reverse-proxy gateway
- [`schloss-ui`](https://github.com/zudaR107/schloss-ui) — shared frontend components
- [`schloss-server-kit`](https://github.com/zudaR107/schloss-server-kit) — shared backend auth/CORS kit

Schlüssel ("key" in German) is the authentication service for this suite of
self-hosted personal services. It's a standalone identity provider: it owns
user accounts and passwords, signs access tokens, and publishes a public key so every
other service can verify those tokens on its own, without calling back to
Schlüssel on every request.

## Authentication flow

Every other service redirects an unauthenticated visitor's browser here to sign in.
Schlüssel hands back a short-lived RS256-signed JWT via an OAuth2 Authorization Code +
PKCE exchange — the login page redirects with a one-time code, never the token itself,
and the caller trades that code for the real access token in a POST response body, so
the token never travels through a URL at all. A long-lived refresh token is set in an
httpOnly cookie scoped to whichever frontend the visitor signed in from. Other services
verify the JWT themselves against Schlüssel's public key, published at
`/.well-known/jwks.json` — no shared secret, no synchronous call back to Schlüssel on
every request.

This repo has two parts:

- the root package — the Hono API (accounts, login/register, invites, JWT issuance,
  JWKS, admin user/invite management, an OpenAPI spec)
- `web/` — the hosted login/register pages every other service redirects to, `/account`
  (the single unified account settings page every service's header links out to instead
  of showing its own), `/admin` (admin-only user/invite management), and `/docs` (an
  admin-only Swagger UI for this service's own API)

### The unified account settings contract

Every Schloss service has one settings surface for things it owns itself (a per-service
preference, a theme, a currency default) and none of them should ever build a second
password/delete-account page of their own — that lives exactly once, here, at `/account`
(editable name, password, active sessions with per-session revoke and "log out
everywhere", delete account). A new service wires this up the same three-line way it
already wires up login:

1. Copy the `buildSchluesselAccountUrl(currentPath, origin?)` helper (see kuvert's or
   schloss's own `lib/authRedirect.ts` for the exact shape — same pattern as the
   existing `buildSchluesselLoginUrl`/`buildSchluesselLogoutUrl` helpers, just a plain
   link with a `return_to`, no PKCE needed since nothing crosses back with a token).
2. Pass `onSettings={() => { window.location.href = buildSchluesselAccountUrl(window.location.pathname) }}`
   to the shared `Header` component instead of routing to a local page — it renders as
   the avatar becoming a clickable button, not a separate settings icon.
3. Keep any real per-service settings (a sidebar page, a preferences panel) reachable
   from the service's own navigation — just not from the header's avatar, which is
   reserved for this page.

### Registration is invite-gated

`POST /register` requires an admin-issued, single-use invite code, except for the very
first account on a fresh install (which becomes the admin). Admins generate invites —
and manage users, view active sessions, force-log-out an account, or delete one — from
`/admin`. There's no self-service email change or 2FA yet; both are explicitly out of
scope for now (no mail-sending infrastructure exists on the platform to verify a new
address).

## Local development

```sh
pnpm install
cp .env.example .env
pnpm dev              # API on http://localhost:4000
pnpm --filter web dev # login/register pages on http://localhost:4001
```

Run the test suites and linter before committing:

```sh
pnpm test
pnpm lint
pnpm --filter web test
pnpm --filter web lint
```

### Environment variables

See `.env.example` for the API. The important ones:

| Variable | Purpose |
|---|---|
| `PORT` | API port (default `4000`) |
| `DATABASE_PATH` | SQLite file path |
| `KEYS_DIR` | Where the RS256 signing keypair is generated/stored on first run |
| `JWT_ISSUER` | Must match what every other service expects as the token issuer |
| `ALLOWED_ORIGINS` | Comma-separated CORS allowlist |

`web/` reads two build-time variables (see `web/Dockerfile`): `VITE_ALLOWED_RETURN_ORIGINS`,
a comma-separated allowlist of origins the hosted login page (and `/account`'s own "back
to app" link) is allowed to redirect back to (a `return_to` pointing anywhere outside
this list is rejected instead of followed - the open-redirect guard), and
`VITE_DEFAULT_APP_URL`, where a visitor who opened `/login` or `/register` directly (no
`return_to` at all) gets sent instead of ever seeing the form - these pages are only
reachable via an external redirect. `/account` is reachable directly (it checks for an
existing session itself, bouncing through `/login` if there isn't one).

## Running with Docker

```sh
docker network create schloss-net   # one-time, shared with the other repos
docker compose up -d
```

Neither service publishes a host port - both are reached through the
[tor](https://github.com/zudaR107/tor) gateway, which fronts the whole platform on one
address (`https://auth.localhost` for this service, in local dev - tor's Caddy
auto-upgrades everything to HTTPS with its own locally-trusted CA). Other Schloss
services on the same `schloss-net` network reach the API directly at
`http://schlussel:4000` (internal Docker network traffic, not through the gateway).

## License

AGPL-3.0 — see [LICENSE](LICENSE).
