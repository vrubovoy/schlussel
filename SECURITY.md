# Security Policy

## Supported versions

Schlüssel is deployed continuously from `main` — there are no maintained
release branches. Security fixes land on `main` and that is the only
supported version.

## Reporting a vulnerability

Please do not open a public issue for security vulnerabilities. Instead,
use GitHub's private reporting flow:

1. Go to the [Security tab](../../security) of this repository.
2. Click "Report a vulnerability".
3. Describe the issue, including reproduction steps if you have them.

This is a small, mostly-solo project, so response time is best-effort, not
contractual — but you can expect an initial reply within a few days.

## Scope

Schlüssel is the identity provider for the whole Hof platform, so it
gets the most careful review of any repo in it. In scope: password
storage/hashing, JWT signing and JWKS key management, the OAuth2
Authorization Code + PKCE exchange (`/auth/login`, `/auth/token`),
refresh-token cookie handling, and the `return_to` open-redirect allowlist
used by the hosted login/register pages.

## Image publish integrity

`.github/workflows/test.yml`'s `publish` job pushes signed, attested
container images to `ghcr.io/vrubovoy/schlussel{,-frontend}`. Its
integrity depends on repository settings kept outside this file:

- **Require actions pinned to a full-length commit SHA**
  (`actions/permissions` → `sha_pinning_required: true`). Every `uses:`
  here is already SHA-pinned.
- **Environment `publish`** with a deployment branch policy allowing only
  the `main` branch and the `v*` tag pattern.
- **Two tag rulesets on `refs/tags/v*`**: one blocking `deletion` /
  `non_fast_forward` / `update` for everyone; one restricting `creation`
  to a repository admin (CI never creates a `v*` tag — a human cuts the
  release).

**Threat model (Model 1).** Every same-repo actor with write access is
trusted; today the only one is a repository admin. A feature branch
controls its own copy of `test.yml` and could drop `environment:` and
request `packages: write`, so the Environment policy gates an *unmodified*
workflow, not a hostile write-collaborator. It still cannot create a `v*`
tag (ruleset) or forge the `@refs/tags/vX.Y.Z` Sigstore identity a
consumer (`hof-ops`'s release lock) checks. Releasing publication
authority from that model would need a dedicated publisher credential; it
is out of scope while the model holds.
