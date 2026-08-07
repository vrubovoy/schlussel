# Schlüssel

[![Test](https://github.com/zudaR107/schlussel/actions/workflows/test.yml/badge.svg)](https://github.com/zudaR107/schlussel/actions/workflows/test.yml)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)

Part of the [Hof platform](https://github.com/zudaR107/Hof) — a suite of
self-hosted personal services:

- [`schloss`](https://github.com/zudaR107/schloss) — home page / launcher
- **`schlussel`** (this repo) — auth: accounts, login, tokens
- [`kuvert`](https://github.com/zudaR107/kuvert) — envelope budgeting
- [`tafel`](https://github.com/zudaR107/tafel) — task/project tracking
- [`zettel`](https://github.com/zudaR107/zettel) — markdown note-taking
- [`glocke`](https://github.com/zudaR107/glocke) — notification center
- [`tor`](https://github.com/zudaR107/tor) — reverse-proxy gateway
- [`schloss-ui`](https://github.com/zudaR107/schloss-ui) — shared frontend components
- [`schloss-server-kit`](https://github.com/zudaR107/schloss-server-kit) — shared backend auth/CORS/notification transport kit

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
the token never travels through a URL at all. The hosted frontend keeps its long-lived
refresh token in a host-only httpOnly cookie; on later redirects it can silently issue a
fresh PKCE code without showing the credentials form again. Other services verify the
JWT themselves against Schlüssel's public key, published at
`/.well-known/jwks.json` — no shared secret, no synchronous call back to Schlüssel on
every request.

The JSON contract uses camelCase even though the browser redirect query uses OAuth-style
snake_case: `POST /auth/login` accepts either just `email` + `password`, or those fields
plus the complete `codeChallenge` + `codeChallengeMethod: "S256"` pair. The optional body
on `POST /auth/refresh` follows the same all-or-none PKCE-pair rule; omit the body (or send
`{}`) for an access token, or send both fields to receive a one-time code for
`POST /auth/token`.

This repo has two parts:

- the root package — the Hono API (accounts, login/register, invites, JWT issuance,
  JWKS, admin user/invite management, an OpenAPI spec)
- `frontend/` — the hosted login/register pages every other service redirects to, `/account`
  (the single unified account settings page every service's header links out to instead
  of showing its own), `/admin` (admin-only user/invite management), and `/docs` (an
  admin-only Swagger UI for this service's own API)

### The unified account settings contract

Every Schloss service has one settings surface for things it owns itself (a per-service
preference, a theme, a currency default) and none of them should ever build a second
password/delete-account page of their own — that lives exactly once, here, at `/account`
(editable name and avatar, password, profile settings, active sessions with per-session
revoke, a per-account session-timeout override, and "log out everywhere", delete account).
A new service wires this up the same three-line way it already wires up login:

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

### Profile settings

`/account`'s profile section is backed by `GET/PATCH /profile` (the extended profile —
`GET /me` itself stays the small `{id,email,name,role}` identity shape every consumer
app's own auth flow already expects), `PUT/DELETE /avatar`, `GET /connected-accounts` +
`DELETE /connected-accounts/:id`, and `GET /export`. Not all of it does something yet —
to be upfront about which parts are real today and which are groundwork:

- **Avatar** (`PUT/DELETE /avatar`) is fully functional: an uploaded image is stored as a
  base64 data URL directly in the `users` row, capped at `MAX_AVATAR_BYTES` (400 KB of
  raw image bytes) — there's no dedicated file-storage service on the platform yet.
- **Session timeout** (`sessionTimeoutMinutes` on `PATCH /profile`) is also fully
  functional: it can shorten — never extend past the platform's own refresh-token
  lifetime — how long a newly-established session lasts.
- **Regional preferences** are stored by `PATCH /profile`. Timezone, date format, and
  week start are included in newly issued access tokens and used by Kuvert, Tafel, and
  Zettel for their date/calendar formatting. Timezones must be valid IANA zone names.
  Language is stored for the ongoing i18n rollout but is not consumed by the apps yet.
- **Notification toggles** are stored here. Glocke reads the in-app preference
  through a separately HMAC-authenticated internal endpoint; browser push and
  Telegram remain future channels.
- **Connected accounts** (`GET /connected-accounts`, `DELETE /connected-accounts/:id`)
  is always empty in practice — Telegram is the only planned provider and there's no bot
  yet to hand a connect flow off to.
- **Data export** keeps `GET /export` for an immediate Schlüssel-only JSON snapshot. The
  `/export-jobs` API creates a durable owner-scoped platform ZIP from the fixed internal
  Schlüssel/Kuvert/Tafel/Zettel/Glocke registry. It exposes progress, cancellation,
  failed-service retry, expiring authenticated downloads, and partial archives.

### Data export contracts

The two download paths are intentionally separate. `GET /export` remains the synchronous,
direct JSON export of Schlüssel-owned account data. Kuvert, Tafel, Zettel, and Glocke each
retain their own synchronous `GET /exports/me` JSON endpoint. Only Schlüssel's
`POST /export-jobs` starts the asynchronous all-services ZIP; Schlüssel reads its own
snapshot locally and calls the other four deployment-owned `/exports/me` URLs.

Remote calls use short-lived RS256 export delegations verified through the same JWKS and
exact issuer as access tokens. A delegation must have `token_use: export`, the single exact
`hof-service:<service>` audience, `data:export` scope, and nonempty subject, job, and token
IDs plus a non-expired numeric `exp`. It is accepted only by that service's
`/exports/me`; ordinary routes and retained legacy export endpoints reject it. The subject
always comes from the verified token, never from request options, and callers cannot
supply or override service URLs.

Each service takes a transactionally consistent local snapshot when its own read runs.
There is no distributed transaction or single platform-wide point-in-time snapshot, so
service timestamps can differ; retrying failed services keeps successful snapshots and
captures the retried services later. If at least one service succeeds and at least one
fails, the job publishes a partial ZIP. `manifest.json` records job and per-service status,
attempts, file names, byte counts, SHA-256 checksums, timestamps, and sanitized errors;
successful envelopes are under `services/`, while failed services get diagnostics under
`errors/` without response bodies.

ZIPs and temporary snapshots are private files. By default, an archive expires 24 hours
after completion, and cleanup removes its job directory; creation is also bounded by a
per-user cooldown, retained-job and retained-byte caps, per-service and aggregate response
limits, a global storage quota, and a free-space reserve. Job APIs and authenticated,
owner-only downloads send `Cache-Control: no-store, private`, `Pragma: no-cache`, and
`X-Content-Type-Options: nosniff`.

Exports contain sensitive personal data and should be stored, transferred, and deleted
accordingly. The platform archive contains only user-facing account data owned by these
five services. It excludes passwords and password hashes, access/refresh/delegation tokens,
signing or HMAC keys, runtime configuration, logs, worker leases, notification inbox
payloads/hashes, internal audit rows, and data belonging to other users.

### Public API routes

`GET /.well-known/jwks.json` publishes the RS256 verification keys and `GET /health`
serves the container health check. `GET/PUT /theme` is also public and unauthenticated:
it stores one install-wide `light`/`dark`/`oled`/`sepia` preference so separate-origin
frontends can synchronize through `ThemeSync`. Writes use last-write-wins `updatedAt`
timestamps; a stale write returns the current winning value, and a timestamp more than
five minutes ahead of server time is rejected so one bad client clock cannot block later
updates indefinitely. The hosted frontend proxies `/theme` to the API during local
development and mounts `ThemeSync` itself, so its theme participates in the same sync.

## Local development

```sh
pnpm install
cp .env.example .env
cp frontend/.env.example frontend/.env
pnpm dev              # API on http://localhost:4000
pnpm --filter frontend dev # login/register pages on http://localhost:4001
```

Run the test suites and linter before committing:

```sh
pnpm test
pnpm lint
pnpm --filter frontend test
pnpm --filter frontend lint
```

### Environment variables

See `.env.example` for the API. The important ones:

| Variable | Purpose |
|---|---|
| `PORT` | API port (default `4000`) |
| `DATABASE_PATH` | SQLite file path |
| `KEYS_DIR` | Where the RS256 signing keypair is generated/stored on first run |
| `EXPORT_DIR` | Private directory for bounded temporary snapshots and expiring ZIP artifacts |
| `JWT_ISSUER` | Must match what every other service expects as the token issuer |
| `ALLOWED_ORIGINS` | Comma-separated CORS allowlist; include every frontend that calls the public `/theme` API directly |
| `GLOCKE_BASE_URL` | Internal Glocke backend URL (default `http://glocke-backend:3004`) |
| `SCHLUSSEL_TO_GLOCKE_HMAC_KEY_ID` / `SCHLUSSEL_TO_GLOCKE_HMAC_SECRET` | Required dedicated credential used to sign outbox event delivery; secret must be at least 32 bytes |
| `GLOCKE_TO_SCHLUSSEL_HMAC_KEY_ID` / `GLOCKE_TO_SCHLUSSEL_HMAC_SECRET` | Separate credential accepted only from Glocke for recipient lookups |
| `GLOCKE_SIGNATURE_MAX_SKEW_SECONDS` | Positive signature timestamp tolerance (default `300`) |
| `GLOCKE_DISPATCH_INTERVAL_MS` / `GLOCKE_OUTBOX_LEASE_MS` / `GLOCKE_FETCH_TIMEOUT_MS` | Positive worker timings; fetch timeout must remain shorter than the lease |
| `GLOCKE_WORKER_STOP_TIMEOUT_MS` | Bound on waiting for the active worker during shutdown (default `5000`) |
| `GLOCKE_MAX_ATTEMPTS` / `GLOCKE_RETRY_BASE_DELAY_MS` / `GLOCKE_RETRY_MAX_DELAY_MS` | Positive durable retry limits and backoff bounds |
| `KUVERT_EXPORT_URL` / `TAFEL_EXPORT_URL` / `ZETTEL_EXPORT_URL` / `GLOCKE_EXPORT_URL` | Deployment-owned internal `/exports/me` registry; request data can never override these URLs |
| `EXPORT_REQUEST_TIMEOUT_MS` / `EXPORT_LEASE_MS` / `EXPORT_DISPATCH_INTERVAL_MS` | Export request, fenced lease, and polling timings; request timeout must be shorter than the lease |
| `EXPORT_MAX_SERVICE_BYTES` / `EXPORT_MAX_AGGREGATE_BYTES` / `EXPORT_MAX_CONCURRENCY` | Per-service, whole-job, and concurrency bounds |
| `EXPORT_ARTIFACT_TTL_MS` / `EXPORT_WORKER_STOP_TIMEOUT_MS` | Artifact retention and graceful shutdown bounds |
| `EXPORT_USER_COOLDOWN_MS` / `EXPORT_MAX_RETAINED_JOBS_PER_USER` | Per-user creation cooldown and retained-job cap |
| `EXPORT_MAX_RETAINED_ARTIFACT_BYTES_PER_USER` | Per-user retained ZIP byte cap |
| `EXPORT_STORAGE_QUOTA_BYTES` / `EXPORT_MIN_FREE_BYTES` | Global export-directory quota and filesystem free-space reserve, checked before writes |

Password changes commit a `schlussel.security.password_changed.v1` event in the
same SQLite transaction as the password and replacement session. A lease-based
worker later posts the shared v1 envelope with the exact
`{ "recipientId": user.id }` payload to Glocke, so Glocke downtime never
adds network work to or rolls back a successful request. Glocke resolves active
recipient preferences through `GET /internal/v1/notification-recipients/:userId`;
this service-to-service route is intentionally omitted from the public OpenAPI
document. Startup rejects missing, short, or reused directional secrets, unsafe key IDs
or Glocke URLs, and invalid timing relationships rather than running with a
partially secure dispatcher.

`frontend/` reads two build-time variables (see `frontend/.env.example` for local
development and `frontend/Dockerfile` for Docker): `VITE_ALLOWED_RETURN_ORIGINS`,
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
