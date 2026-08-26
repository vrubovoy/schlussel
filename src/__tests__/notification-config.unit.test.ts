import { describe, expect, it } from 'vitest'
import { loadNotificationConfig } from '../config.js'

function files(contents: Buffer | string, options: { regular?: boolean; size?: number; failRead?: boolean } = {}) {
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents)
  return {
    stat: () => ({ isFile: () => options.regular ?? true, size: options.size ?? bytes.length }),
    read: () => {
      if (options.failRead) throw new Error('injected read failure')
      return bytes
    },
  }
}

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

  it('normalizes the Glocke origin once at startup', () => {
    expect(loadNotificationConfig(validEnv({
      GLOCKE_BASE_URL: 'https://glocke.example.test/',
    })).glockeBaseUrl).toBe('https://glocke.example.test')
  })

  it('rejects reuse of one HMAC secret in both trust directions', () => {
    const sharedSecret = 'shared-directional-secret'.repeat(2)
    expect(() => loadNotificationConfig(validEnv({
      SCHLUSSEL_TO_GLOCKE_HMAC_SECRET: sharedSecret,
      GLOCKE_TO_SCHLUSSEL_HMAC_SECRET: sharedSecret,
    }))).toThrow('Directional HMAC secrets must be distinct')
  })

  it('loads a secret file, removes exactly one terminal newline, and preserves other bytes', () => {
    const env = validEnv({
      SCHLUSSEL_TO_GLOCKE_HMAC_SECRET: '',
      SCHLUSSEL_TO_GLOCKE_HMAC_SECRET_FILE: '/run/secrets/outbound',
    })
    const secret = `${' s'.repeat(16)}\n\n`

    const config = loadNotificationConfig(env, files(secret))

    expect(config.outboundSecret).toBe(secret.slice(0, -1))
    expect(env.SCHLUSSEL_TO_GLOCKE_HMAC_SECRET).toBe('')
  })

  it('accepts CRLF and removes it as one terminal line ending', () => {
    const env = validEnv({
      GLOCKE_TO_SCHLUSSEL_HMAC_SECRET: undefined,
      GLOCKE_TO_SCHLUSSEL_HMAC_SECRET_FILE: '/run/secrets/inbound',
    })
    expect(loadNotificationConfig(env, files(`${'g'.repeat(32)}\r\n`)).inboundSecret).toBe('g'.repeat(32))
  })

  it.each([
    ['both direct and file values', validEnv({ SCHLUSSEL_TO_GLOCKE_HMAC_SECRET_FILE: '/secret' }), files('x'.repeat(32))],
    ['file path whitespace', validEnv({ SCHLUSSEL_TO_GLOCKE_HMAC_SECRET: '', SCHLUSSEL_TO_GLOCKE_HMAC_SECRET_FILE: ' /secret' }), files('x'.repeat(32))],
    ['non-regular file', validEnv({ SCHLUSSEL_TO_GLOCKE_HMAC_SECRET: '', SCHLUSSEL_TO_GLOCKE_HMAC_SECRET_FILE: '/secret' }), files('x'.repeat(32), { regular: false })],
    ['file over 64 KiB', validEnv({ SCHLUSSEL_TO_GLOCKE_HMAC_SECRET: '', SCHLUSSEL_TO_GLOCKE_HMAC_SECRET_FILE: '/secret' }), files('x'.repeat(32), { size: 65_537 })],
    ['read failure', validEnv({ SCHLUSSEL_TO_GLOCKE_HMAC_SECRET: '', SCHLUSSEL_TO_GLOCKE_HMAC_SECRET_FILE: '/secret' }), files('x'.repeat(32), { failRead: true })],
    ['invalid UTF-8', validEnv({ SCHLUSSEL_TO_GLOCKE_HMAC_SECRET: '', SCHLUSSEL_TO_GLOCKE_HMAC_SECRET_FILE: '/secret' }), files(Buffer.from([0xc3, 0x28]))],
    ['empty after newline removal', validEnv({ SCHLUSSEL_TO_GLOCKE_HMAC_SECRET: '', SCHLUSSEL_TO_GLOCKE_HMAC_SECRET_FILE: '/secret' }), files('\n')],
    ['NUL byte', validEnv({ SCHLUSSEL_TO_GLOCKE_HMAC_SECRET: '', SCHLUSSEL_TO_GLOCKE_HMAC_SECRET_FILE: '/secret' }), files(`${'x'.repeat(32)}\0`)],
  ])('rejects %s without exposing file contents', (_case, env, access) => {
    let error: unknown
    try {
      loadNotificationConfig(env, access)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).not.toContain('x'.repeat(32))
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
