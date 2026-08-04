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
