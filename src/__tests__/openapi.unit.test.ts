import { describe, it, expect } from 'vitest'
import { openApiDocument } from '../openapi.js'

// Purely descriptive generation - this just checks the document that
// GET /auth/openapi.json serves is well-formed and actually covers the
// routes it's meant to document, not that any individual route's runtime
// behavior matches (that's covered by the integration tests for each
// route itself).
describe('openApiDocument', () => {
  it('is a valid OpenAPI 3.0 document with the expected metadata', () => {
    expect(openApiDocument.openapi).toBe('3.0.0')
    expect(openApiDocument.info.title).toBe('Schlüssel Auth API')
  })

  it('registers a bearer auth security scheme', () => {
    expect(openApiDocument.components?.securitySchemes?.['bearerAuth']).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    })
  })

  it('documents every self-service auth route', () => {
    const paths = Object.keys(openApiDocument.paths ?? {})
    for (const path of [
      '/register', '/login', '/token', '/refresh', '/logout', '/me',
      '/password', '/account', '/name', '/profile', '/avatar',
      '/connected-accounts', '/connected-accounts/{id}', '/export',
      '/sessions', '/sessions/{id}',
    ]) {
      expect(paths).toContain(path)
    }
  })

  it('documents every method for profile, avatar, connected-account, and export routes', () => {
    expect(openApiDocument.paths?.['/profile']).toMatchObject({ get: {}, patch: {} })
    expect(openApiDocument.paths?.['/avatar']).toMatchObject({ put: {}, delete: {} })
    expect(openApiDocument.paths?.['/connected-accounts']).toMatchObject({ get: {} })
    expect(openApiDocument.paths?.['/connected-accounts/{id}']).toMatchObject({ delete: {} })
    expect(openApiDocument.paths?.['/export']).toMatchObject({ get: {} })
  })

  it('requires bearer auth for every profile and account-data operation', () => {
    for (const operation of [
      openApiDocument.paths?.['/profile']?.get,
      openApiDocument.paths?.['/profile']?.patch,
      openApiDocument.paths?.['/avatar']?.put,
      openApiDocument.paths?.['/avatar']?.delete,
      openApiDocument.paths?.['/connected-accounts']?.get,
      openApiDocument.paths?.['/connected-accounts/{id}']?.delete,
      openApiDocument.paths?.['/export']?.get,
    ]) {
      expect(operation?.security).toEqual([{ bearerAuth: [] }])
      expect(operation?.responses).toHaveProperty('401')
    }
  })

  it('documents the public theme, health, and JWKS routes with their actual methods', () => {
    expect(openApiDocument.paths?.['/theme']).toMatchObject({ get: {}, put: {} })
    expect(openApiDocument.paths?.['/health']).toMatchObject({ get: {} })
    expect(openApiDocument.paths?.['/.well-known/jwks.json']).toMatchObject({ get: {} })
  })

  it('overrides the /auth server prefix for every public operation', () => {
    for (const operation of [
      openApiDocument.paths?.['/theme']?.get,
      openApiDocument.paths?.['/theme']?.put,
      openApiDocument.paths?.['/health']?.get,
      openApiDocument.paths?.['/.well-known/jwks.json']?.get,
    ]) {
      expect(operation?.servers).toEqual([{ url: '/' }])
      expect(operation?.security).toBeUndefined()
    }
  })

  it('documents theme ordering and future-timestamp validation', () => {
    const operation = openApiDocument.paths?.['/theme']?.put
    expect(operation?.description).toContain('last-write-wins')
    expect(operation?.description).toContain('five minutes ahead')
    expect(operation?.description).toContain('stale or equal write')
    expect(operation?.requestBody).toMatchObject({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              theme: { type: 'string', enum: ['light', 'dark', 'oled', 'sepia'] },
              updatedAt: { type: 'integer', minimum: 0 },
            },
            required: ['theme', 'updatedAt'],
          },
        },
      },
    })
  })

  it('documents the optional PKCE request body accepted by POST /refresh', () => {
    const requestBody = openApiDocument.paths?.['/refresh']?.post?.requestBody
    expect(requestBody).toMatchObject({
      required: false,
      content: {
        'application/json': {
          schema: {
            anyOf: [
              {
                type: 'object',
                properties: {
                  codeChallenge: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
                  codeChallengeMethod: { type: 'string', enum: ['S256'] },
                },
                required: ['codeChallenge', 'codeChallengeMethod'],
              },
              {
                type: 'object',
                properties: {},
                additionalProperties: false,
              },
            ],
          },
        },
      },
    })
  })

  it('documents login PKCE fields as all-or-none', () => {
    const requestBody = openApiDocument.paths?.['/login']?.post?.requestBody
    expect(requestBody).toMatchObject({
      content: {
        'application/json': {
          schema: {
            anyOf: [
              {
                type: 'object',
                properties: {
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string' },
                  codeChallenge: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
                  codeChallengeMethod: { type: 'string', enum: ['S256'] },
                },
                required: ['email', 'password', 'codeChallenge', 'codeChallengeMethod'],
              },
              {
                type: 'object',
                properties: {
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string' },
                },
                required: ['email', 'password'],
                additionalProperties: false,
              },
            ],
          },
        },
      },
    })
  })

  it('documents login, token, and refresh success bodies and propagated profile claims', () => {
    const documentText = JSON.stringify({
      login: openApiDocument.paths?.['/login']?.post,
      token: openApiDocument.paths?.['/token']?.post,
      refresh: openApiDocument.paths?.['/refresh']?.post,
    })

    expect(openApiDocument.paths?.['/login']?.post?.responses?.['200']).toHaveProperty('content.application/json.schema')
    expect(openApiDocument.paths?.['/token']?.post?.responses?.['200']).toHaveProperty('content.application/json.schema')
    expect(openApiDocument.paths?.['/refresh']?.post?.responses?.['200']).toHaveProperty('content.application/json.schema')
    expect(documentText).toContain('timezone')
    expect(documentText).toContain('dateFormat')
    expect(documentText).toContain('weekStart')
    expect(documentText).toContain('nullable JWT claims')
  })

  it('documents IANA timezone validation and profile-setting token propagation', () => {
    const operation = openApiDocument.paths?.['/profile']?.patch
    expect(operation?.description).toContain('valid IANA zone')
    expect(operation?.description).toContain('included in newly issued access tokens')
    expect(operation?.responses?.['400']?.description).toContain('unrecognized IANA timezone')
    expect(operation?.requestBody).toMatchObject({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              timezone: { maxLength: 100 },
              dateFormat: {},
              weekStart: {},
            },
          },
        },
      },
    })
  })

  it('documents every admin-only route', () => {
    const paths = Object.keys(openApiDocument.paths ?? {})
    for (const path of [
      '/invites', '/invites/{id}', '/admin/users', '/admin/users/{id}/role',
      '/admin/users/{id}/sessions', '/admin/users/{id}', '/admin/stats',
    ]) {
      expect(paths).toContain(path)
    }
  })

  it('marks every admin-only path as requiring bearer auth', () => {
    for (const path of ['/invites', '/admin/users', '/admin/stats']) {
      const item = openApiDocument.paths?.[path]
      const operation = item?.post ?? item?.get ?? item?.patch ?? item?.delete
      expect(operation?.security).toEqual([{ bearerAuth: [] }])
    }
  })
})
