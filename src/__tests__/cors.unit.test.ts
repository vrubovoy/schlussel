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

  it('allows Glocke theme and profile requests in the backend default', async () => {
    const previous = process.env['ALLOWED_ORIGINS']
    delete process.env['ALLOWED_ORIGINS']
    vi.resetModules()

    try {
      const [{ Hono }, { corsMiddleware }] = await Promise.all([
        import('hono'),
        import('../middleware/cors.js'),
      ])
      const app = new Hono()
      app.use('*', corsMiddleware)
      app.get('/theme', (c) => c.json({ theme: 'dark' }))
      app.patch('/auth/profile', (c) => c.json({ ok: true }))

      for (const [path, method] of [['/theme', 'GET'], ['/auth/profile', 'PATCH']]) {
        const response = await app.request(path, {
          method,
          headers: { Origin: 'https://glocke.localhost' },
        })
        expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://glocke.localhost')
      }
    } finally {
      if (previous === undefined) delete process.env['ALLOWED_ORIGINS']
      else process.env['ALLOWED_ORIGINS'] = previous
    }
  })
})
