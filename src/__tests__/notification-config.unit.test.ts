import { describe, expect, it } from 'vitest'
import { loadNotificationConfig } from '../config.js'

function validEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    GLOCKE_BASE_URL: 'http://glocke-backend:3004',
    SCHLUSSEL_TO_GLOCKE_HMAC_KEY_ID: 'schlussel-v1',
    SCHLUSSEL_TO_GLOCKE_HMAC_SECRET: 's'.repeat(32),
    GLOCKE_TO_SCHLUSSEL_HMAC_KEY_ID: 'glocke-v1',
    GLOCKE_TO_SCHLUSSEL_HMAC_SECRET: 'g'.repeat(32),
    ...overrides,
  }
}

describe('notification startup configuration', () => {
  it('loads safe credentials, URL, and positive timing defaults', () => {
    expect(loadNotificationConfig(validEnv())).toMatchObject({
      glockeBaseUrl: 'http://glocke-backend:3004',
      outboundKeyId: 'schlussel-v1',
      inboundKeyId: 'glocke-v1',
      signatureMaxSkewSeconds: 300,
      dispatchIntervalMs: 1_000,
      leaseMs: 30_000,
      fetchTimeoutMs: 10_000,
      workerStopTimeoutMs: 5_000,
      maxAttempts: 8,
      baseDelayMs: 1_000,
      maxDelayMs: 900_000,
    })
  })

  it('rejects reuse of one HMAC secret in both trust directions', () => {
    const sharedSecret = 'shared-directional-secret'.repeat(2)
    expect(() => loadNotificationConfig(validEnv({
      SCHLUSSEL_TO_GLOCKE_HMAC_SECRET: sharedSecret,
      GLOCKE_TO_SCHLUSSEL_HMAC_SECRET: sharedSecret,
    }))).toThrow('Directional HMAC secrets must be distinct')
  })

  it.each([
    ['short outbound secret', { SCHLUSSEL_TO_GLOCKE_HMAC_SECRET: 'short' }],
    ['short inbound secret', { GLOCKE_TO_SCHLUSSEL_HMAC_SECRET: 'short' }],
    ['missing outbound secret', { SCHLUSSEL_TO_GLOCKE_HMAC_SECRET: undefined }],
    ['missing inbound secret', { GLOCKE_TO_SCHLUSSEL_HMAC_SECRET: undefined }],
    ['unsafe outbound key ID', { SCHLUSSEL_TO_GLOCKE_HMAC_KEY_ID: '../key' }],
    ['unsafe inbound key ID', { GLOCKE_TO_SCHLUSSEL_HMAC_KEY_ID: 'key with spaces' }],
    ['non-HTTP Glocke URL', { GLOCKE_BASE_URL: 'file:///tmp/glocke' }],
    ['credential-bearing Glocke URL', { GLOCKE_BASE_URL: 'http://user:password@glocke:3004' }],
    ['path-bearing Glocke URL', { GLOCKE_BASE_URL: 'http://glocke:3004/api' }],
    ['zero interval', { GLOCKE_DISPATCH_INTERVAL_MS: '0' }],
    ['fractional lease', { GLOCKE_OUTBOX_LEASE_MS: '100.5' }],
    ['non-numeric retry delay', { GLOCKE_RETRY_BASE_DELAY_MS: 'soon' }],
    ['timer above the Node range', { GLOCKE_DISPATCH_INTERVAL_MS: '2147483648' }],
    ['timeout equal to lease', { GLOCKE_FETCH_TIMEOUT_MS: '30000' }],
    ['retry cap below base', { GLOCKE_RETRY_BASE_DELAY_MS: '2000', GLOCKE_RETRY_MAX_DELAY_MS: '1000' }],
  ])('rejects %s at startup', (_case, overrides) => {
    expect(() => loadNotificationConfig(validEnv(overrides))).toThrow()
  })
})
