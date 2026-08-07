import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const compose = readFileSync(resolve(process.cwd(), '../docker-compose.yml'), 'utf8')
const backendEnvExample = readFileSync(resolve(process.cwd(), '../.env.example'), 'utf8')
const frontendEnvExample = readFileSync(resolve(process.cwd(), '.env.example'), 'utf8')
const frontendDockerfile = readFileSync(resolve(process.cwd(), 'Dockerfile'), 'utf8')

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

  it('allows Glocke in every development, Compose, and Docker origin default', async () => {
    const composeCorsOrigins = compose.match(/ALLOWED_ORIGINS=\$\{SCHLUSSEL_ALLOWED_ORIGINS:-([^}]+)\}/)?.[1]
    const composeReturnOrigins = compose.match(/VITE_ALLOWED_RETURN_ORIGINS:\s*\$\{ALLOWED_RETURN_ORIGINS:-([^}]+)\}/)?.[1]
    const dockerReturnOrigins = frontendDockerfile.match(/ARG VITE_ALLOWED_RETURN_ORIGINS=([^\n]+)/)?.[1]
    const backendDevelopmentOrigins = backendEnvExample.match(/^ALLOWED_ORIGINS=([^\n]+)$/m)?.[1]
    const frontendDevelopmentOrigins = frontendEnvExample.match(/^VITE_ALLOWED_RETURN_ORIGINS=([^\n]+)$/m)?.[1]

    for (const origins of [
      composeCorsOrigins,
      composeReturnOrigins,
      dockerReturnOrigins,
      backendDevelopmentOrigins,
      frontendDevelopmentOrigins,
    ]) {
      expect(origins?.split(',')).toContain('https://glocke.localhost')
    }

    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', composeReturnOrigins)
    vi.resetModules()
    const { readReturnTo } = await import('../lib/returnTo')
    expect(readReturnTo('?return_to=https%3A%2F%2Fglocke.localhost%2Fnotifications')).toEqual({
      present: true,
      valid: true,
      url: 'https://glocke.localhost/notifications',
    })
  })

  it('keeps the local launcher as the default app redirect', () => {
    const defaultApp = compose.match(/VITE_DEFAULT_APP_URL:\s*\$\{DEFAULT_APP_URL:-([^}]+)\}/)?.[1]
    expect(defaultApp).toBe('https://localhost')
  })
})
