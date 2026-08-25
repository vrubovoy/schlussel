import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const testId = randomUUID().slice(0, 8)
const DB_PATH = join(tmpdir(), `schlussel-deletion-worker-${testId}.db`)
const KEYS_DIR = join(tmpdir(), `schlussel-deletion-worker-keys-${testId}`)
const MIGRATIONS_DIR = fileURLToPath(new URL('../db/migrations', import.meta.url))
const NOW = new Date('2026-08-25T12:00:00.000Z')
const URLS = {
  kuvert: 'http://kuvert/internal/v1/account-deletions',
  tafel: 'http://tafel/internal/v1/account-deletions',
  zettel: 'http://zettel/internal/v1/account-deletions',
  glocke: 'http://glocke/internal/v1/account-deletions',
  schrank: 'http://schrank/internal/v1/account-deletions',
  herold: 'http://herold/internal/v1/account-deletions',
} as const

process.env['DATABASE_PATH'] = DB_PATH
process.env['KEYS_DIR'] = KEYS_DIR

let sqlite: import('better-sqlite3').Database
let dispatch: typeof import('../services/deletionSaga.js')['dispatchDeletionTarget']

beforeAll(async () => {
  mkdirSync(KEYS_DIR, { recursive: true })
  const [keys, saga, database, migrator] = await Promise.all([
    import('../utils/keys.js'), import('../services/deletionSaga.js'), import('../db/index.js'),
    import('drizzle-orm/better-sqlite3/migrator'),
  ])
  await keys.initKeys()
  sqlite = database.sqlite
  dispatch = saga.dispatchDeletionTarget
  migrator.migrate(database.db, { migrationsFolder: MIGRATIONS_DIR })
})

beforeEach(() => {
  sqlite.exec('DELETE FROM deletion_job_targets; DELETE FROM deletion_jobs')
})

afterAll(() => {
  try { sqlite?.close() } catch { /* ignore */ }
  try { rmSync(DB_PATH, { force: true }) } catch { /* ignore */ }
  try { rmSync(KEYS_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
})

function insert(service = 'kuvert', attempts = 0, status = 'pending', leaseUntil: number | null = null) {
  sqlite.prepare(`INSERT INTO deletion_jobs (id, user_id, initiated_by, status, created_at)
    VALUES ('job-1', 'user-1', 'self', 'pending', ?)`).run(NOW.getTime())
  sqlite.prepare(`INSERT INTO deletion_job_targets
    (job_id, service, status, attempts, next_attempt_at, lease_id, lease_until)
    VALUES ('job-1', ?, ?, ?, ?, ?, ?)`).run(
    service, status, attempts, NOW.getTime(), status === 'inflight' ? 'old-lease' : null, leaseUntil,
  )
}

function options(fetchImpl: typeof fetch, overrides: Partial<Parameters<typeof dispatch>[0]> = {}) {
  return {
    fetch: fetchImpl, now: () => NOW, random: () => 0.5, createId: () => 'new-lease',
    serviceUrls: URLS, leaseMs: 30_000, fetchTimeoutMs: 10_000, maxAttempts: 3,
    baseDelayMs: 1_000, maxDelayMs: 60_000, ...overrides,
  }
}

describe('account deletion target worker', () => {
  it('sends exact job/subject claims and completes a successful target', async () => {
    insert()
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const token = new Headers(init?.headers).get('Authorization')!.slice(7)
      const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString())
      expect(payload).toMatchObject({
        sub: 'user-1', aud: 'hof-deletion:kuvert', token_use: 'deletion',
        scope: 'account:delete', job_id: 'job-1',
      })
      expect(JSON.parse(init?.body as string)).toEqual({ jobId: 'job-1', userId: 'user-1' })
      return new Response(null, { status: 200 })
    })
    expect(await dispatch(options(fetchImpl))).toBe(1)
    expect(sqlite.prepare('SELECT status, attempts FROM deletion_job_targets').get())
      .toEqual({ status: 'delivered', attempts: 1 })
    expect(sqlite.prepare('SELECT status FROM deletion_jobs').get()).toEqual({ status: 'completed' })
  })

  it('reclaims expired leases and schedules bounded retry for transient failures', async () => {
    insert('tafel', 1, 'inflight', NOW.getTime() - 1)
    await dispatch(options(vi.fn<typeof fetch>(async () => new Response(null, { status: 503 }))))
    expect(sqlite.prepare('SELECT status, attempts, next_attempt_at, lease_id FROM deletion_job_targets').get())
      .toEqual({ status: 'pending', attempts: 2, next_attempt_at: NOW.getTime() + 1_000, lease_id: null })
    expect(sqlite.prepare('SELECT status FROM deletion_jobs').get()).toEqual({ status: 'running' })
  })

  it('makes mismatches and exhausted attempts terminal and observable', async () => {
    insert('herold', 2)
    await dispatch(options(vi.fn<typeof fetch>(async () => new Response(null, { status: 409 }))))
    expect(sqlite.prepare('SELECT status, attempts, last_error FROM deletion_job_targets').get())
      .toEqual({ status: 'permanent', attempts: 3, last_error: 'HTTP 409' })
    expect(sqlite.prepare('SELECT status FROM deletion_jobs').get()).toEqual({ status: 'failed' })
  })
})
