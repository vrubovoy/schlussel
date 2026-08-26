import { describe, expect, it } from 'vitest'
import { loadDeletionConfig } from '../config.js'

describe('account deletion configuration', () => {
  it('treats a deployment with no configured deletion URLs as having no optional services enabled', () => {
    const config = loadDeletionConfig({})
    expect(config.serviceUrls).toEqual({})
    expect(config.maxAttempts).toBe(8)
    expect(config.fetchTimeoutMs).toBeLessThan(config.leaseMs)
  })

  it('resolves only the deletion URLs an operator actually configured', () => {
    const config = loadDeletionConfig({
      SCHRANK_DELETION_URL: 'http://schrank-backend:3005/internal/v1/account-deletions',
      HEROLD_DELETION_URL: 'http://herold-backend:3006/internal/v1/account-deletions',
    })
    expect(Object.keys(config.serviceUrls)).toEqual(['schrank', 'herold'])
    expect(config.serviceUrls.schrank).toBe('http://schrank-backend:3005/internal/v1/account-deletions')
  })

  it.each([
    ['credentials in a URL', { KUVERT_DELETION_URL: 'http://user:pass@kuvert/internal/v1/account-deletions' }],
    ['a request-controlled path', { TAFEL_DELETION_URL: 'http://tafel/other' }],
    ['a timeout equal to its lease', { DELETION_FETCH_TIMEOUT_MS: '1000', DELETION_LEASE_MS: '1000' }],
    ['an unbounded attempt count', { DELETION_MAX_ATTEMPTS: '0' }],
    ['inverted retry bounds', { DELETION_RETRY_BASE_DELAY_MS: '1000', DELETION_RETRY_MAX_DELAY_MS: '999' }],
  ])('rejects %s', (_name, env) => {
    expect(() => loadDeletionConfig(env)).toThrow()
  })
})
