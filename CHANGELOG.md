# Changelog

Brief log of notable changes, grouped by theme — not a full commit history
(see `git log` for that). New entries get appended under the section they
fit best; add a new section if none fits.

## Account lifecycle
- Added transactionally enqueued self/admin account deletion jobs with six
  fixed service targets, per-target short-lived JWTs, leased bounded retries,
  terminal status, and admin observability.

## Notifications
- Added stable `sid` claims to session-backed access tokens and durable,
  per-session Glocke cleanup events for logout, password changes, account
  deletion, and user/admin session revocation. PKCE and trusted refresh rotation
  preserve the same session identity; legacy access tokens remain readable.
- Added the shared Glocke notification bell and unread-count lifecycle to
  authenticated account, admin, docs, and access-denied headers. It reuses each
  page's in-memory token, publishes silently refreshed tokens back to page-owned
  state without redirecting, generation-fences late refreshes, and stays absent from
  login, registration, error, and public help pages. Same-origin refreshes are
  globally single-flight to protect the rotating session cookie. The bell href uses
  shared origin normalization and is omitted for invalid or insecure configuration.
- Added a transactional password-change outbox and lease-based Glocke
  dispatcher using the shared v1 envelope, canonical HMAC signing, response
  classification, `Retry-After`, and backoff helpers from `schloss-server-kit`.
- Added the separately authenticated internal Glocke recipient-preference API;
  it returns only the active user ID, in-app preference, language, and timezone
  and is intentionally excluded from the public OpenAPI document.
- Extended the internal Glocke recipient-preference API with the global
  `notifyBrowserPush` switch, and reworked the Account page's browser-push
  toggle: it now links to Glocke's browser-push settings once enabled,
  explains that disabling stops delivery without deregistering browsers, and
  fixed a failed-save unhandled promise rejection so it now surfaces a
  visible error and reverts the checkbox. Privacy copy discloses the
  browser vendor's own push infrastructure as a non-tracking third-party
  transport.

## Data export
- Completed the fixed platform archive registry with Schrank and Herold,
  including distinct export-token audiences and validated deployment URLs. New
  jobs have seven service rows while retained five-service jobs remain unchanged.
- Retained the synchronous Schlüssel-only `GET /export` JSON response and added
  durable, owner-scoped `/export-jobs` for an asynchronous ZIP assembled from
  Schlüssel, Kuvert, Tafel, Zettel, and Glocke through a fixed internal registry.
- Added exact service-audience export delegations, per-service progress and
  failed-service retry, partial archives with a checksum/timestamp manifest,
  authenticated no-store downloads, expiring private artifacts, and per-user,
  response-size, storage-quota, and free-space bounds.

## Auth
- Hosted login/register web UI, JWKS-based token verification, fragment-based
  token handoff to other services via `return_to`.
- Guarded `/login` and `/register` behind a valid `return_to`, so they're no
  longer reachable by typing the URL directly - a successful sign-in now
  always redirects instead of sometimes dead-ending on a static card.
- Added password confirmation and a show/hide toggle to the auth forms.
- Switched the login handoff to OAuth2 Authorization Code + PKCE: the
  token is no longer delivered via URL fragment. `POST /auth/login` now
  optionally issues a short-lived one-time code instead of a token, and a
  new `POST /auth/token` exchanges it (plus the PKCE verifier) for the
  real access token in a JSON response body.
- Replaced an earlier `COOKIE_DOMAIN` attempt (didn't work - `localhost`
  has no embedded dot, so browsers won't share a Domain-scoped cookie
  across its subdomains, the same rule that stops a site setting a cookie
  for `.com`) with silent re-authentication: `/auth/login`'s PKCE branch
  now also establishes a same-origin session, and `/auth/refresh` can
  issue a PKCE code from that session instead of an access token. The
  hosted login page tries this first and only shows the credentials form
  if it fails - a session started on one service now carries over to the
  others without ever sharing a cookie across subdomains.
- Restore the stored theme before first paint (a synchronous inline
  script in index.html's `<head>`, not just after the JS bundle mounts)
  and render a themed blank div instead of nothing while the login page
  checks for an existing session - reduces the flash during the SSO
  silent-reauth redirect chain, which loads and unloads this page within
  a fraction of a second.
- Added a `/logout` page. schloss/kuvert's own logout buttons couldn't
  actually clear the session cookie - it's host-only to this origin (no
  Domain attribute, by design), so a fetch to `/auth/logout` proxied
  through their own origin never carried it, silently leaving the
  session intact and making logout look like it did nothing (the
  redirect to the login page would just silently re-authenticate via
  the still-valid session). This new page does the logout same-origin
  (where the cookie is actually readable) via a real browser
  navigation, then bounces back to `return_to`.
- Restricted self-registration: `POST /auth/register` now requires an
  admin-issued, single-use invite code (except for the very first user on
  a fresh install). Invite redemption is atomic - a conditional update
  inside a transaction, so two concurrent registrations racing the same
  code can't both succeed. New `PATCH /admin/users/:id/role`,
  `DELETE /admin/users/:id/sessions` (force-logout), and
  `DELETE /admin/users/:id` (password-confirmed) admin endpoints, all
  guarded against leaving the platform with zero admins.
- Added an admin-only OpenAPI spec (`GET /auth/openapi.json`) generated
  from the existing route Zod schemas, purely additive/descriptive - it
  has no effect on runtime request validation.
- Security audit fixes: `DELETE /auth/account` (self-service deletion)
  gained the same last-admin guard the admin-mediated user-management
  routes already had - without it, the platform's sole admin could delete
  their own account and permanently lock everyone out (no admin left to
  ever issue another invite). `POST /auth/login`'s no-PKCE branch no
  longer unconditionally establishes a session cookie regardless of
  origin - `codeChallenge` is optional, so any consumer app's own
  `/auth/*` proxy could reach this exact branch and get a real,
  persistent cookie planted on its own origin; now gated by
  `isTrustedOrigin` like every other session-establishing path. The
  last-admin guard itself (role-change and delete-another-user) is now a
  single synchronous transaction rather than a separate read then write -
  closes a narrow race where two concurrent requests against two
  different admins could both read "more than one admin left" before
  either write commits. Added a per-IP failed-attempt limiter to `/login`
  (resets on success) - invite/PKCE codes are already unguessable by
  brute force, so this only needed to cover password guessing.
- Fixed a bare invite link (`/register#invite=...`) bouncing a logged-out
  visitor to `/login` instead of showing the registration form. `hasInvite`
  was re-derived from `window.location.hash` on every render instead of
  being captured once; a later re-render (triggered once an unrelated
  async effect resolves) ran after the invite fragment had already been
  stripped from the URL by another effect, so it read back `false` and
  fired the "no invite, no external caller" redirect guard for the first
  time. Now captured once on mount so a later effect stripping the URL
  fragment can't retroactively change what the page thinks it was opened
  with.
- Fixed keyboard focus not moving to a field after it fails validation
  (client-side, or an API error like a 409 on an already-registered
  email) - the field got a red border and an error message, but the
  visitor had to notice and click it manually before they could correct
  it. Added a small `focusField`/`focusFirstError` helper and wired it
  into every form's error-setting code path across `RegisterPage`,
  `LoginPage`, and `AccountPage`'s profile/password/delete-account cards.
- Fixed the above focus fix making Chrome/Edge pop up their saved-password
  picker under the registration email field (it sits right before the
  password fields, so the browser treats it as a "username" field and
  offers the picker on any focus, including a programmatic one) - nothing
  to autofill here, this is registration, not login. Applied the standard
  "readonly until focus" technique to that one field: readonly at the
  moment any focus event fires (what the browser checks before showing the
  picker), made editable again within that same event before the visitor
  can type, and set back to readonly on blur so the next focus is guarded
  the same way.
- Applied the same readonly-until-focus guard to the login form's email
  field - it has the identical "username before a password field" shape,
  so the picker was still appearing there while filling in the form.

## UI
- New `/admin` page: user management (role, force-logout, delete),
  invite creation/journal with a shareable `/register#invite=...` link,
  and a small platform-stats overview.
- New `/docs` page: an admin-only Swagger UI for this service's own API,
  fed by the new spec endpoint.
- `RegisterPage` gained an invite-code field (prefillable from
  `#invite=`) and no longer bounces a bare invite link away before
  showing the form - previously only an externally-supplied
  `return_to`/`code_challenge` pair counted as a legitimate reason to
  render it.
- Added a header (brand mark linking back to schloss) and footer to the
  login/register pages and the return_to error page - previously bare
  form cards with no chrome connecting them to the rest of the platform,
  matching schloss's Header/Footer component structure.
- Adopted `@zudar107/schloss-ui`: Header/Footer now wrap the shared
  package's versions (own brand mark, no more visible "Schlüssel" text
  next to the logo - the logo icon is the home link, with the brand name
  conveyed via a title tooltip instead), the name/email/password fields
  on Login/RegisterPage use the shared `Field` component, and the submit
  buttons use the shared `Button`. The password show/hide toggle now
  layers on `Field`'s new `suffix` slot (added in schloss-ui v0.2.0)
  instead of a bespoke absolutely-positioned button. Kept the platform's
  original blue (`#3b82f6`) as schlussel's own accent, now an explicit
  local override on top of the shared tokens instead of an accidental
  shared default.
- `/admin` and `/docs` weren't linked from anywhere in the normal UI - the
  only way to reach either was typing the URL directly. Added an
  admin-only "Администрирование" shortcut card on `/account` linking to
  `/admin` (which already links onward to `/docs`), plus small back-links
  from `/admin` to `/account` and from `/docs` to `/admin`, so the three
  pages form a discoverable loop.
- Every form (Register, Login, account name/password/delete, admin
  delete-user) now validates its own inputs client-side and highlights
  the specific invalid field in red, instead of one generic banner at the
  bottom - new `lib/validation.ts` centralizes the rules (name:
  letters/space/hyphen/apostrophe only, no digits; email format; password
  length; password match). `/login`'s wrong-email-vs-wrong-password stays
  deliberately merged into one message highlighting both fields without
  saying which is at fault - splitting it would reintroduce the
  user-enumeration gap the security audit above just closed. Bumped
  `schloss-ui` for `Field`'s new `error`-driven red border and `invalid`
  prop (a shared message highlighting a field without duplicating text
  under it), both needed here.
- Invite links now carry the code in the URL fragment (`#invite=...`)
  instead of a query param (`?invite=...`) - a query param is sent in the
  HTTP request line and can end up in Caddy's access logs or a
  same-origin Referer header; a fragment never leaves the browser.
  `RegisterPage` strips it from the visible address bar via
  `history.replaceState` right after reading it. One-click link UX is
  unchanged.
- Bumped the vendored `schloss-ui` submodule pointer to pick up
  `ThemeToggle`'s dropdown-positioning fix (schloss-ui#59/#60) - routine
  sync, no behavior change reported for schlussel's own header.
- Added `frontend/public/theme-sync.html`: a small static "hub" page for
  cross-origin theme-preference sync. schloss's and kuvert's frontends
  embed it in a hidden iframe (their own `localStorage` can't be read
  from another origin directly) and exchange `postMessage` with it to
  keep the shared `schloss-theme`/`schloss-theme-updated-at` keys in sync
  - last write wins, by timestamp, relayed live between multiple open hub
  instances via `BroadcastChannel` so a change made in one app's tab
  reaches another app's already-open tab without a reload. Plain vanilla
  JS - it's a static file, not part of the React app. Needs
  `tor`'s narrow CSP exception (zudaR107/tor#23) to actually be
  frame-able cross-origin.
- Bumped `schloss-ui` again: cross-origin theme sync didn't actually
  work, a freshly-visited origin's own default-theme timestamp could
  outrank a real pick made moments earlier on another origin
  (schloss-ui#64) - routine sync, the hub page itself doesn't have this
  bug (it never invents a timestamp of its own).
- Removed `frontend/public/theme-sync.html` and replaced it with a real
  `GET`/`PUT /theme` API: the hidden-iframe + `postMessage` design read/
  wrote the hub page's own `localStorage`, which Firefox's Total Cookie
  Protection (and Safari's ITP) partitions by whichever site embeds the
  iframe - the exact same hub page embedded in schloss's and kuvert's
  tabs saw two completely separate storage buckets, so nothing ever
  actually synced, independent of any application-level bug. `/theme` is
  public/unauthenticated (a single shared value for the whole install,
  not per-user) - last write wins by an `updatedAt` client-supplied
  counter, stored in a new `theme_preference` table. Added kuvert's own
  origin to `ALLOWED_ORIGINS`'s default (it now calls this endpoint
  directly, cross-origin) - it was missing before, harmless while the
  iframe approach didn't need CORS at all.
- Expanded `/account` with editable avatar and regional/notification
  preferences, connected-account status, scoped JSON export, and session
  lifetime controls, backed by the new profile/avatar/connected/export API
  routes.
- Added timezone, date-format, and week-start preferences to newly issued
  access tokens so Kuvert, Tafel, and Zettel can consume the central profile
  settings without synchronous calls back to Schlüssel. Language remains
  stored for the ongoing i18n rollout.
- Hardened platform synchronization inputs: profile timezones must resolve as
  IANA zones, and `/theme` rejects timestamps more than five minutes ahead of
  the server while allowing ordinary client clock skew.
- Mounted the API-backed `ThemeSync` in Schlüssel's own frontend and proxied
  `/theme` in its Vite dev server, so theme changes made on the auth/account
  origin participate in the same timestamp reconciliation as consumer apps.

## Infrastructure
- CI (tests + lint) on every push/PR.
- Docker Compose networking on a shared `schloss-net`.
- Migrated from nginx to Caddy in the frontend image.
- Docker images published to GHCR on merge to `main`.
- Dependabot for both npm and GitHub Actions dependencies.
- Dropped published host ports - reached only through the tor gateway now.
- Fixed docker-compose.yml's default `ALLOWED_ORIGINS`/
  `VITE_ALLOWED_RETURN_ORIGINS`/`VITE_DEFAULT_APP_URL` to `https://` - tor's
  gateway auto-upgrades everything to HTTPS, so the old `http://` defaults
  failed the return_to allowlist for anyone running the real stack.
- Renamed docker-compose.yml's outer `ALLOWED_ORIGINS` substitution
  variable to `SCHLUSSEL_ALLOWED_ORIGINS` - it was silently colliding with
  kuvert-api's own `ALLOWED_ORIGINS` default when tor's compose file
  includes both under one shared `.env`. Container-internal env var name
  is unchanged.
- Pinned `pnpm/action-setup`'s version exactly in CI - letting it
  self-update to the latest 11.x broke every workflow run once pnpm
  11.12.0 shipped with a bug in its own self-installer, unrelated to
  any change in this repo.
- Fixed the API image's Docker build after adopting schloss-ui: this
  repo is a pnpm workspace, and `pnpm install --frozen-lockfile`
  fetches every package in the lockfile to verify it (not just the
  current project's own deps, even with `--filter`) - so the API
  image needed GitHub Packages auth too, despite never using
  `@zudar107/schloss-ui` itself. Added the same BuildKit-secret
  `.npmrc` auth already used in `frontend/Dockerfile`.
- Bumped `schloss-ui` for `StatTile`'s row-misalignment fix (a long
  wrapped label no longer pushes its tile's value down relative to its
  row's other tiles) and `Badge`'s baseline-mismatch fix against plain
  text - both hit on `/admin`'s overview and invites journal while
  testing.
- Pinned `better-sqlite3` back to `^12.11.1` after a routine Dependabot
  bump to `13.0.1` broke both Docker images (root API and `frontend`, which
  installs against the same shared lockfile) - v13 dropped prebuilt
  binaries entirely, so install always compiles from source via
  `node-gyp` now, on every platform, instead of just downloading a
  matching binary like every 12.x release does. Added a Dependabot
  `ignore` rule for `better-sqlite3` major-version bumps so this can't
  silently reintroduce itself.

## Docs
- README, AGPL-3.0 LICENSE, CONTRIBUTING.md.
- License/CI badges, a link to the Hof meta-repo, fixed gateway repo URL
  casing after its rename to lowercase.
- Wrote the gateway's project name lowercase ("tor") everywhere in prose.
- Added CODE_OF_CONDUCT.md, SECURITY.md, issue templates, and a pull
  request template. Fixed a stale README line still describing the old
  fragment-based token handoff.
- Refreshed README after the invites/admin panel/OpenAPI batch (the
  settings-icon reference was stale - it's the avatar now) and added an
  "Updated docs" line to the PR checklist template.
- Added a `/help` page: a plain-language usage guide for regular end
  users, covering registration (incl. invite links), signing in,
  password change, active sessions, account deletion, and theme -
  deliberately excludes admin-only functionality. Reachable without
  being logged in (unlike `/account`, `/admin`, `/docs`), since someone
  stuck at login/registration is exactly who needs it. Text skeleton
  only for now, with screenshot slots at `frontend/public/guide/schlussel-*.png`
  for the user to fill in later.
- Fixed the `/help` page's "Первые шаги" numbered list rendering with no
  visible `1./2./3.` markers - just unexplained indentation. Tailwind's
  preflight base styles reset `ol`/`ul` to `list-style: none`; the page's
  own inline style set the indent (`paddingLeft`) but never restored a
  `list-style-type`. Added `listStyleType: 'decimal'` explicitly.
- Expanded the generated OpenAPI contract to cover every public and profile
  route, the all-or-none PKCE pairs accepted by login and refresh, profile
  propagation in newly issued tokens, and the theme timestamp limit.
