import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const compose = readFileSync(resolve(process.cwd(), '../docker-compose.yml'), 'utf8')
const dockerfile = readFileSync(resolve(process.cwd(), 'Dockerfile'), 'utf8')
const caddyfile = readFileSync(resolve(process.cwd(), 'Caddyfile'), 'utf8')
const entrypoint = readFileSync(resolve(process.cwd(), 'docker-entrypoint.sh'), 'utf8')
const indexHtml = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8')
const publicConfig = readFileSync(resolve(process.cwd(), 'public/config.js'), 'utf8')

describe('frontend runtime configuration deployment', () => {
  it('loads the synchronous runtime config before the module bundle', () => {
    expect(indexHtml.indexOf('<script src="/config.js"></script>')).toBeGreaterThan(-1)
    expect(indexHtml.indexOf('<script src="/config.js"></script>')).toBeLessThan(indexHtml.indexOf('type="module"'))
    expect(publicConfig).toContain('schemaVersion: 1')
    expect(publicConfig).toContain("defaultAppUrl: 'http://localhost:3000'")
    expect(publicConfig).toContain("glockeUrl: 'http://localhost:5177'")
  })

  it('passes deployment values at runtime rather than as Vite build arguments', () => {
    expect(compose).toContain('ALLOWED_RETURN_ORIGINS=${ALLOWED_RETURN_ORIGINS:-')
    expect(compose).toContain('DEFAULT_APP_URL=${DEFAULT_APP_URL:-https://localhost}')
    expect(compose).toContain('GLOCKE_URL=${GLOCKE_URL:-https://glocke.localhost}')
    expect(dockerfile).not.toContain('ARG VITE_')
    expect(dockerfile).toContain('apk add --no-cache jq')
  })

  it('writes JSON safely and atomically, then serves only exact /config.js without caching', () => {
    expect(entrypoint).toContain('jq -cn')
    expect(entrypoint).toContain('mv -f "$config_tmp" /config/config.js')
    expect(entrypoint).toContain('exec caddy run')
    expect(caddyfile).toMatch(/handle \/config\.js \{[\s\S]*header Cache-Control "no-store"[\s\S]*file_server/)
  })
})
