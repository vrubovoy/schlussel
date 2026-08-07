# Contributing to Schlüssel

Thanks for considering a contribution. This project is small and self-hosted-first, so
please keep changes focused and in scope with the rest of the Hof platform.

## Getting set up

```sh
pnpm install
cp .env.example .env
cp frontend/.env.example frontend/.env
pnpm dev              # API on http://localhost:4000
pnpm --filter frontend dev # login/register pages on http://localhost:4001
```

See the [README](README.md) for environment variables and running the full stack with
Docker alongside `schloss` and `kuvert`.

## Before opening a PR

- Run `pnpm test` and `pnpm lint` (and the same under `pnpm --filter frontend`) — CI runs both
  and will block merges that don't pass.
- Add or update tests for any behavior change.
- Keep commits focused; one logical change per PR is easier to review than several
  bundled together.
- Write commit messages that explain *why*, not just *what* — the diff already shows
  what changed.

## Opening a PR

- Branch from `main`.
- Reference the issue you're addressing if one exists (`Closes #123`).
- Describe what you tested and how, especially for anything touching auth or token
  handling — this service is the security boundary for the whole platform, so changes
  here get read carefully.

## Reporting bugs / security issues

Open a regular issue for bugs. For anything that looks like a security vulnerability
(token handling, the open-redirect allowlist, password storage), please use GitHub's
private "Report a vulnerability" flow under this repo's Security tab instead of a public
issue.
