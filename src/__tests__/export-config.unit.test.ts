import { describe, expect, it } from 'vitest'
import { loadExportConfig } from '../config.js'

describe('export startup configuration', () => {
  it('uses conservative concurrency, retention, and filesystem safety defaults', () => {
    expect(loadExportConfig({})).toMatchObject({
      maxConcurrency: 1,
      userCooldownMs: 60_000,
      maxRetainedJobsPerUser: 3,
      maxRetainedArtifactBytesPerUser: 300 * 1024 * 1024,
      storageQuotaBytes: 1024 * 1024 * 1024,
      minFreeBytes: 256 * 1024 * 1024,
    })
  })

  it.each([
    ['caller-like URL query', { KUVERT_EXPORT_URL: 'http://kuvert:3001/exports/me?url=https://evil.invalid' }],
    ['credentials in URL', { TAFEL_EXPORT_URL: 'http://user:password@tafel:3002/exports/me' }],
    ['wrong path', { ZETTEL_EXPORT_URL: 'http://zettel:3003/arbitrary' }],
    ['negative cooldown', { EXPORT_USER_COOLDOWN_MS: '-1' }],
    ['zero retained jobs', { EXPORT_MAX_RETAINED_JOBS_PER_USER: '0' }],
    ['per-user bytes below aggregate', { EXPORT_MAX_RETAINED_ARTIFACT_BYTES_PER_USER: '1000' }],
    ['global quota below two aggregate snapshots', { EXPORT_STORAGE_QUOTA_BYTES: '104857601' }],
  ])('rejects %s', (_case, env) => {
    expect(() => loadExportConfig(env)).toThrow()
  })
})
