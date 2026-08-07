import { afterEach, describe, expect, it, vi } from 'vitest'

describe('CORS preflight', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('advertises PATCH for an allowed origin', async () => {
    vi.stubEnv('ALLOWED_ORIGINS', 'https://auth.localhost')
    vi.resetModules()

    const [{ Hono }, { corsMiddleware }] = await Promise.all([
      import('hono'),
      import('../middleware/cors.js'),
    ])
    const app = new Hono()
    app.use('*', corsMiddleware)
    app.patch('/auth/profile', (c) => c.json({ ok: true }))

    const response = await app.request('/auth/profile', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://auth.localhost',
        'Access-Control-Request-Method': 'PATCH',
      },
    })

    expect(response.status).toBe(204)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://auth.localhost')
    expect(response.headers.get('Access-Control-Allow-Methods')?.split(/,\s*/)).toContain('PATCH')
  })
})
