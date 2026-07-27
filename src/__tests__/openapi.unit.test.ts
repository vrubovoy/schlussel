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
      '/password', '/account', '/name', '/sessions', '/sessions/{id}',
    ]) {
      expect(paths).toContain(path)
    }
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
