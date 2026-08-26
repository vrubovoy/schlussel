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

  it('treats an unconfigured service URL as disabled, not a fallback internal hostname', () => {
    expect(loadExportConfig({})).toMatchObject({
      kuvertUrl: undefined,
      tafelUrl: undefined,
      zettelUrl: undefined,
      glockeUrl: undefined,
      schrankUrl: undefined,
      heroldUrl: undefined,
    })
  })

  it('resolves only the service URLs an operator actually configured', () => {
    expect(loadExportConfig({ SCHRANK_EXPORT_URL: 'http://schrank-backend:3005/exports/me' })).toMatchObject({
      schrankUrl: 'http://schrank-backend:3005/exports/me',
      heroldUrl: undefined,
    })
  })

  it.each([
    ['caller-like URL query', { KUVERT_EXPORT_URL: 'http://kuvert:3001/exports/me?url=https://evil.invalid' }],
    ['credentials in URL', { TAFEL_EXPORT_URL: 'http://user:password@tafel:3002/exports/me' }],
    ['wrong path', { ZETTEL_EXPORT_URL: 'http://zettel:3003/arbitrary' }],
    ['unsafe Schrank URL', { SCHRANK_EXPORT_URL: 'file:///tmp/schrank-export' }],
    ['unsafe Herold URL', { HEROLD_EXPORT_URL: 'https://user:secret@herold:3006/exports/me' }],
    ['negative cooldown', { EXPORT_USER_COOLDOWN_MS: '-1' }],
    ['zero retained jobs', { EXPORT_MAX_RETAINED_JOBS_PER_USER: '0' }],
    ['per-user bytes below aggregate', { EXPORT_MAX_RETAINED_ARTIFACT_BYTES_PER_USER: '1000' }],
    ['global quota below two aggregate snapshots', { EXPORT_STORAGE_QUOTA_BYTES: '104857601' }],
  ])('rejects %s', (_case, env) => {
    expect(() => loadExportConfig(env)).toThrow()
  })
})
