import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const compose = readFileSync(resolve(process.cwd(), '../docker-compose.yml'), 'utf8')

describe('default frontend return configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('allows a protected page on auth.localhost as a same-origin return_to target', async () => {
    const defaultOrigins = compose.match(/VITE_ALLOWED_RETURN_ORIGINS:\s*\$\{ALLOWED_RETURN_ORIGINS:-([^}]+)\}/)?.[1]
    expect(defaultOrigins, 'docker-compose VITE_ALLOWED_RETURN_ORIGINS default').toBeDefined()
    expect(defaultOrigins?.split(',')).toContain('https://auth.localhost')

    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', defaultOrigins)
    vi.resetModules()
    const { readReturnTo } = await import('../lib/returnTo')

    expect(readReturnTo('?return_to=https%3A%2F%2Fauth.localhost%2Faccount')).toEqual({
      present: true,
      valid: true,
      url: 'https://auth.localhost/account',
    })
  })

  it('keeps the local launcher as the default app redirect', () => {
    const defaultApp = compose.match(/VITE_DEFAULT_APP_URL:\s*\$\{DEFAULT_APP_URL:-([^}]+)\}/)?.[1]
    expect(defaultApp).toBe('https://localhost')
  })
})
