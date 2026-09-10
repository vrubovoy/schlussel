#!/usr/bin/env bash
# Prints the real HTTP status GHCR returns for a manifest reference, or
# "ERR-<what>" if the check itself could not be completed. Never exits
# non-zero - the caller decides what a given status means.
#
#   $1  repository path under ghcr.io, e.g. vrubovoy/hof-ops-ee
#   $2  a tag or digest reference, e.g. ee-v0.1.7 or sha256:...
#
# Reads GHCR_USER / GHCR_TOKEN from the environment for the registry
# token exchange (in CI: github.actor / secrets.GITHUB_TOKEN, the same
# credentials docker/login-action uses).
#
# 200  -> the manifest exists
# 404  -> it genuinely does not (the ONLY "free to publish" signal)
# anything else (401/403/429/5xx/000/ERR-*) -> inconclusive; fail closed
set -uo pipefail

repo="${1:?repository path required}"
reference="${2:?manifest reference required}"
: "${GHCR_USER:?GHCR_USER required}" "${GHCR_TOKEN:?GHCR_TOKEN required}"

token="$(curl -sS --fail --max-time 20 -u "${GHCR_USER}:${GHCR_TOKEN}" \
  "https://ghcr.io/token?scope=repository:${repo}:pull" 2>/dev/null \
  | jq -r '.token // .access_token // empty' 2>/dev/null)"
if [ -z "${token}" ]; then
  printf 'ERR-token'
  exit 0
fi

# curl writes %{http_code} even on a transport failure (it is "000"
# then), so capture it once and print exactly that - never a doubled
# "000000".
status="$(curl -sS -I -o /dev/null --max-time 20 -w '%{http_code}' \
  -H "Authorization: Bearer ${token}" \
  -H 'Accept: application/vnd.oci.image.index.v1+json' \
  -H 'Accept: application/vnd.oci.image.manifest.v1+json' \
  -H 'Accept: application/vnd.docker.distribution.manifest.list.v2+json' \
  -H 'Accept: application/vnd.docker.distribution.manifest.v2+json' \
  "https://ghcr.io/v2/${repo}/manifests/${reference}" 2>/dev/null)" || true
printf '%s' "${status:-000}"
