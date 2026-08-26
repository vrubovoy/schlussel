#!/bin/sh
set -eu

config_tmp="$(mktemp /config/config.js.XXXXXX)"
trap 'rm -f "$config_tmp"' EXIT HUP INT TERM

printf 'window.__HOF_CONFIG__ = ' > "$config_tmp"
jq -cn \
  --arg origins "${ALLOWED_RETURN_ORIGINS:-https://localhost,https://auth.localhost,https://kuvert.localhost,https://tafel.localhost,https://zettel.localhost,https://glocke.localhost}" \
  --arg defaultAppUrl "${DEFAULT_APP_URL:-https://localhost}" \
  --arg glockeUrl "${GLOCKE_URL:-}" \
  --argjson glockeEnabled "$([ -n "${GLOCKE_URL:-}" ] && echo true || echo false)" \
  '{
    schemaVersion: 1,
    allowedReturnOrigins: ($origins | split(",") | map(gsub("^\\s+|\\s+$"; "") | select(length > 0))),
    defaultAppUrl: $defaultAppUrl,
    glockeUrl: $glockeUrl,
    services: { glocke: $glockeEnabled }
  }' >> "$config_tmp"
printf ';\n' >> "$config_tmp"
chmod 0644 "$config_tmp"
mv -f "$config_tmp" /config/config.js
trap - EXIT HUP INT TERM

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
