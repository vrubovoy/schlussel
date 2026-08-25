import { describe, expect, it } from 'vitest'
import { loadDeletionConfig } from '../config.js'

describe('account deletion configuration', () => {
  it('loads the fixed six-service internal endpoint registry and bounded defaults', () => {
    const config = loadDeletionConfig({})
    expect(Object.keys(config.serviceUrls)).toEqual([
      'kuvert', 'tafel', 'zettel', 'glocke', 'schrank', 'herold',
    ])
    expect(config.serviceUrls.schrank).toBe('http://schrank-backend:3005/internal/v1/account-deletions')
    expect(config.maxAttempts).toBe(8)
    expect(config.fetchTimeoutMs).toBeLessThan(config.leaseMs)
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
