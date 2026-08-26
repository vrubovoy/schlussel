import { describe, expect, it } from 'vitest'
import { DEFAULT_RUNTIME_CONFIG, parseRuntimeConfig } from '../lib/runtimeConfig'

describe('parseRuntimeConfig', () => {
  it('uses documented localhost defaults when fields are missing', () => {
    expect(parseRuntimeConfig({})).toEqual(DEFAULT_RUNTIME_CONFIG)
  })

  it('normalizes valid origin-only allowlist entries', () => {
    expect(parseRuntimeConfig({
      schemaVersion: 1,
      allowedReturnOrigins: ['HTTPS://Example.COM:443/', 'http://localhost:8080'],
      defaultAppUrl: 'https://example.com/apps',
      glockeUrl: 'https://glocke.example.com/',
    })).toEqual({
      schemaVersion: 1,
      allowedReturnOrigins: ['https://example.com', 'http://localhost:8080'],
      defaultAppUrl: 'https://example.com/apps',
      glockeUrl: 'https://glocke.example.com',
    })
  })

  it.each([
    'https://user@example.com',
    'https://example.com/path',
    'https://example.com?query=1',
    'https://example.com/#hash',
    'file:///tmp/config',
    'not-a-url',
  ])('rejects invalid explicit allowlist entry %s', (origin) => {
    expect(() => parseRuntimeConfig({ allowedReturnOrigins: [origin] })).toThrow(/allowedReturnOrigins\[0\]/)
  })

  it('rejects invalid explicit schema and URL fields', () => {
    expect(() => parseRuntimeConfig({ schemaVersion: 2 })).toThrow(/schemaVersion/)
    expect(() => parseRuntimeConfig({ defaultAppUrl: 'javascript:alert(1)' })).toThrow(/defaultAppUrl/)
    expect(() => parseRuntimeConfig({ glockeUrl: 'https://glocke.example.com/path' })).toThrow(/glockeUrl/)
  })
})
