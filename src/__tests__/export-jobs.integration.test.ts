import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Hono } from 'hono'

const testId = randomUUID().slice(0, 8)
const DB_PATH = join(tmpdir(), `schlussel-test-export-jobs-${testId}.db`)
const KEYS_DIR = join(tmpdir(), `schlussel-keys-export-jobs-${testId}`)
const EXPORT_DIR = join(tmpdir(), `schlussel-exports-${testId}`)
const MIGRATIONS_DIR = fileURLToPath(new URL('../db/migrations', import.meta.url))

process.env['DATABASE_PATH'] = DB_PATH
process.env['KEYS_DIR'] = KEYS_DIR
process.env['EXPORT_DIR'] = EXPORT_DIR
process.env['JWT_ISSUER'] = 'schlussel'

interface JobResponse {
  id: string
  status: 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'expired'
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  expiresAt: string | null
  downloadUrl: string | null
  error: string | null
  services: Array<{
    service: 'schlussel' | 'kuvert' | 'tafel' | 'zettel' | 'glocke' | 'schrank' | 'herold'
    status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'
    attempts: number
    bytes: number | null
    sha256: string | null
    error: string | null
  }>
}

interface WorkerOptions {
  fetch: typeof fetch
  now: () => Date
  exportDir: string
  requestTimeoutMs?: number
  maxResponseBytes?: number
  maxConcurrency?: number
  leaseMs?: number
  artifactTtlMs?: number
  storageQuotaBytes?: number
  minFreeBytes?: number
  maxUserRetainedArtifactBytes?: number
  availableBytes?: (path: string) => number
}

let app: Hono
let sqlite: import('better-sqlite3').Database
let dispatchExportJobBatch: (options: WorkerOptions) => Promise<number>

beforeAll(async () => {
  mkdirSync(KEYS_DIR, { recursive: true })
  mkdirSync(EXPORT_DIR, { recursive: true })

  const [keysModule, authModule, adminModule, workerModule, dbModule, migratorModule, honoModule] =
    await Promise.all([
      import('../utils/keys.js'),
      import('../routes/auth.js'),
      import('../routes/admin.js'),
      import('../services/exportWorker.js'),
      import('../db/index.js'),
      import('drizzle-orm/better-sqlite3/migrator'),
      import('hono'),
    ])

  sqlite = dbModule.sqlite
  dispatchExportJobBatch = workerModule.dispatchExportJobBatch
  await keysModule.initKeys()
  migratorModule.migrate(dbModule.db, { migrationsFolder: MIGRATIONS_DIR })

  const testApp = new honoModule.Hono()
  testApp.route('/auth', authModule.authRouter)
  testApp.route('/auth', adminModule.adminRouter)
  app = testApp
})

beforeEach(() => {
  sqlite.exec('DELETE FROM export_job_services')
  sqlite.exec('DELETE FROM export_jobs')
  sqlite.exec('DELETE FROM connected_accounts')
  sqlite.exec('DELETE FROM invites')
  sqlite.exec('DELETE FROM auth_codes')
  sqlite.exec('DELETE FROM refresh_tokens')
  sqlite.exec('DELETE FROM users')
  rmSync(EXPORT_DIR, { recursive: true, force: true })
  mkdirSync(EXPORT_DIR, { recursive: true })
})

afterAll(() => {
  try { sqlite?.close() } catch { /* ignore */ }
  rmSync(DB_PATH, { force: true })
  rmSync(KEYS_DIR, { recursive: true, force: true })
  rmSync(EXPORT_DIR, { recursive: true, force: true })
})

const JSON_HEADERS = { 'Content-Type': 'application/json' }

function request(method: string, path: string, token?: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: {
      ...(body === undefined ? {} : JSON_HEADERS),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function registerAndLogin(email: string, name: string) {
  const register = await request('POST', '/auth/register', undefined, {
    email,
    password: 'password123',
    name,
  })
  expect(register.status).toBe(201)
  const registered = await register.json() as { id: string }

  const login = await app.request('/auth/login', {
    method: 'POST',
    headers: { ...JSON_HEADERS, 'X-Schlussel-Frontend': '1' },
    body: JSON.stringify({ email, password: 'password123' }),
  })
  expect(login.status).toBe(200)
  const session = await login.json() as { accessToken: string }
  return { userId: registered.id, accessToken: session.accessToken }
}

async function secondUser(adminToken: string) {
  const inviteResponse = await request('POST', '/auth/invites', adminToken, {})
  expect(inviteResponse.status).toBe(201)
  const { code } = await inviteResponse.json() as { code: string }
  const register = await request('POST', '/auth/register', undefined, {
    email: 'bob@example.com',
    password: 'password123',
    name: 'Bob',
    inviteCode: code,
  })
  expect(register.status).toBe(201)
  const login = await app.request('/auth/login', {
    method: 'POST',
    headers: { ...JSON_HEADERS, 'X-Schlussel-Frontend': '1' },
    body: JSON.stringify({ email: 'bob@example.com', password: 'password123' }),
  })
  const body = await login.json() as { accessToken: string }
  return body.accessToken
}

async function createJob(token: string): Promise<{ response: Response; job: JobResponse }> {
  const response = await request('POST', '/auth/export-jobs', token, {})
  const job = await response.json() as JobResponse
  return { response, job }
}

function successfulFetch(): typeof fetch {
  return async (input) => {
    const url = new URL(String(input))
    const service = url.hostname.split('-')[0]
    return Response.json({
      version: '1',
      service,
      exportedAt: '2026-08-07T10:00:00.000Z',
      data: { marker: `${service}-alice-data` },
    })
  }
}

function workerOptions(fetchImpl: typeof fetch = successfulFetch()): WorkerOptions {
  return {
    fetch: fetchImpl,
    now: () => new Date('2026-08-07T10:00:00.000Z'),
    exportDir: EXPORT_DIR,
    requestTimeoutMs: 100,
    maxResponseBytes: 1024 * 1024,
    maxConcurrency: 2,
    leaseMs: 1_000,
    artifactTtlMs: 60_000,
  }
}

describe('platform export job HTTP API', () => {
  it.each([
    ['POST', '/auth/export-jobs'],
    ['GET', `/auth/export-jobs/${randomUUID()}`],
    ['DELETE', `/auth/export-jobs/${randomUUID()}`],
    ['POST', `/auth/export-jobs/${randomUUID()}/retry`],
    ['GET', `/auth/export-jobs/${randomUUID()}/download`],
  ])('%s %s requires bearer authentication', async (method, path) => {
    const response = await request(method, path)
    expect(response.status).toBe(401)
    expect(response.headers.get('Cache-Control')).toMatch(/no-store/i)
    expect(response.headers.get('Pragma')).toBe('no-cache')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('creates durable queued work and returns 202 with all static services', async () => {
    const { accessToken } = await registerAndLogin('alice@example.com', 'Alice')

    const { response, job } = await createJob(accessToken)

    expect(response.status).toBe(202)
    expect(response.headers.get('Location')).toBe(`/auth/export-jobs/${job.id}`)
    expect(job).toMatchObject({
      status: 'queued',
      startedAt: null,
      completedAt: null,
      expiresAt: null,
      downloadUrl: null,
    })
    expect(job.id).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(job.services.map(({ service }) => service)).toEqual([
      'schlussel', 'kuvert', 'tafel', 'zettel', 'glocke', 'schrank', 'herold',
    ])
    expect(job.services).toEqual(job.services.map((service) => ({
      ...service,
      status: 'pending',
      attempts: 0,
      bytes: null,
      sha256: null,
      error: null,
    })))

    const row = sqlite.prepare(
      'SELECT owner_user_id, status FROM export_jobs WHERE id = ?',
    ).get(job.id) as { owner_user_id: string; status: string }
    expect(row).toEqual({ owner_user_id: expect.any(String), status: 'queued' })
    expect(sqlite.prepare(
      'SELECT count(*) AS count FROM export_job_services WHERE job_id = ?',
    ).get(job.id)).toEqual({ count: 7 })
  })

  it('returns retained five-service jobs without adding or changing rows', async () => {
    const { accessToken, userId } = await registerAndLogin('alice@example.com', 'Alice')
    const id = 'historical-five-service-job'
    sqlite.prepare(`
      INSERT INTO export_jobs (id, owner_user_id, status, created_at, completed_at)
      VALUES (?, ?, 'completed', ?, ?)
    `).run(id, userId, Date.now() - 120_000, Date.now() - 60_000)
    const insertService = sqlite.prepare(`
      INSERT INTO export_job_services (job_id, service, status, attempts)
      VALUES (?, ?, 'succeeded', 1)
    `)
    const historicalServices = ['schlussel', 'kuvert', 'tafel', 'zettel', 'glocke']
    for (const service of historicalServices) insertService.run(id, service)

    const before = sqlite.prepare(`
      SELECT service, status, attempts FROM export_job_services WHERE job_id = ? ORDER BY rowid
    `).all(id)
    const response = await request('GET', `/auth/export-jobs/${id}`, accessToken)

    expect(response.status).toBe(200)
    expect((await response.json() as JobResponse).services.map(({ service }) => service)).toEqual(historicalServices)
    expect(sqlite.prepare(`
      SELECT service, status, attempts FROM export_job_services WHERE job_id = ? ORDER BY rowid
    `).all(id)).toEqual(before)
  })

  it('rejects user-supplied service URLs instead of extending the static registry', async () => {
    const { accessToken } = await registerAndLogin('alice@example.com', 'Alice')
    const response = await request('POST', '/auth/export-jobs', accessToken, {
      services: [{ service: 'kuvert', url: 'https://attacker.invalid/export' }],
    })

    expect(response.status).toBe(400)
    expect(sqlite.prepare('SELECT count(*) AS count FROM export_jobs').get()).toEqual({ count: 0 })
  })

  it('makes concurrent double-click creation idempotent for an active owner job', async () => {
    const { accessToken } = await registerAndLogin('alice@example.com', 'Alice')

    const [first, second] = await Promise.all([createJob(accessToken), createJob(accessToken)])

    expect(first.response.status).toBe(202)
    expect(second.response.status).toBe(202)
    expect(second.job.id).toBe(first.job.id)
    expect(sqlite.prepare('SELECT count(*) AS count FROM export_jobs').get()).toEqual({ count: 1 })
  })

  it('allows a new job after the prior job reaches a terminal state', async () => {
    const { accessToken } = await registerAndLogin('alice@example.com', 'Alice')
    const first = await createJob(accessToken)
    await dispatchExportJobBatch(workerOptions())
    sqlite.prepare('UPDATE export_jobs SET created_at = ? WHERE id = ?').run(Date.now() - 61_000, first.job.id)

    const second = await createJob(accessToken)

    expect(second.response.status).toBe(202)
    expect(second.job.id).not.toBe(first.job.id)
  })

  it('enforces a per-user creation cooldown after terminal work', async () => {
    const { accessToken } = await registerAndLogin('alice@example.com', 'Alice')
    await createJob(accessToken)
    await dispatchExportJobBatch(workerOptions())

    const response = await request('POST', '/auth/export-jobs', accessToken, {})

    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toMatch(/^\d+$/)
  })

  it('enforces retained job and artifact limits per owner', async () => {
    const { accessToken, userId } = await registerAndLogin('alice@example.com', 'Alice')
    const first = await createJob(accessToken)
    await dispatchExportJobBatch(workerOptions())
    sqlite.prepare('UPDATE export_jobs SET created_at = ? WHERE id = ?').run(Date.now() - 61_000, first.job.id)
    for (const id of ['retained-2', 'retained-3']) {
      sqlite.prepare(`
        INSERT INTO export_jobs (id, owner_user_id, status, created_at, completed_at)
        VALUES (?, ?, 'failed', ?, ?)
      `).run(id, userId, Date.now() - 120_000, Date.now() - 120_000)
    }
    expect((await request('POST', '/auth/export-jobs', accessToken, {})).status).toBe(429)

    sqlite.prepare("DELETE FROM export_jobs WHERE id IN ('retained-2', 'retained-3')").run()
    sqlite.prepare(`
      UPDATE export_jobs SET archive_bytes = 314572800, created_at = ? WHERE id = ?
    `).run(Date.now() - 61_000, first.job.id)
    const artifactLimited = await request('POST', '/auth/export-jobs', accessToken, {})
    expect(artifactLimited.status).toBe(429)
    expect(await artifactLimited.json()).toEqual({ error: 'Retained export artifact limit reached' })
  })

  it('isolates status, cancellation, retry, and download by owner without revealing job existence', async () => {
    const alice = await registerAndLogin('alice@example.com', 'Alice')
    const bobToken = await secondUser(alice.accessToken)
    const { job } = await createJob(alice.accessToken)

    for (const [method, suffix] of [
      ['GET', ''],
      ['DELETE', ''],
      ['POST', '/retry'],
      ['GET', '/download'],
    ] as const) {
      const response = await request(method, `/auth/export-jobs/${job.id}${suffix}`, bobToken)
      expect(response.status).toBe(404)
    }
  })

  it('cancels queued work durably and the worker never starts it', async () => {
    const { accessToken } = await registerAndLogin('alice@example.com', 'Alice')
    const { job } = await createJob(accessToken)

    const cancelledResponse = await request('DELETE', `/auth/export-jobs/${job.id}`, accessToken)

    expect(cancelledResponse.status).toBe(202)
    expect(await cancelledResponse.json()).toMatchObject({ id: job.id, status: 'cancelled' })
    let calls = 0
    const fetchMock: typeof fetch = async () => {
      calls += 1
      return Response.json({ data: {} })
    }
    expect(await dispatchExportJobBatch(workerOptions(fetchMock))).toBe(0)
    expect(calls).toBe(0)
    expect((await request('GET', `/auth/export-jobs/${job.id}/download`, accessToken)).status).toBe(409)
  })

  it('returns owner-scoped progress and an authenticated no-store ZIP download', async () => {
    const { accessToken } = await registerAndLogin('alice@example.com', 'Alice')
    const { job } = await createJob(accessToken)
    expect(await dispatchExportJobBatch(workerOptions())).toBe(1)

    const statusResponse = await request('GET', `/auth/export-jobs/${job.id}`, accessToken)
    expect(statusResponse.status).toBe(200)
    const completed = await statusResponse.json() as JobResponse
    expect(completed).toMatchObject({
      id: job.id,
      status: 'completed',
      startedAt: expect.any(String),
      completedAt: expect.any(String),
      expiresAt: expect.any(String),
      downloadUrl: `/auth/export-jobs/${job.id}/download`,
    })
    expect(completed.services.every((service) => service.status === 'succeeded')).toBe(true)

    const download = await request('GET', `/auth/export-jobs/${job.id}/download`, accessToken)
    expect(download.status).toBe(200)
    expect(download.headers.get('Content-Type')).toBe('application/zip')
    expect(download.headers.get('Cache-Control')).toMatch(/no-store/i)
    expect(download.headers.get('Pragma')).toBe('no-cache')
    expect(download.headers.get('Content-Disposition')).toMatch(/^attachment; filename="hof-export-[A-Za-z0-9_-]+\.zip"$/)
    expect(download.headers.get('Content-Length')).toBeNull()
    expect(download.body).not.toBeNull()
    expect((await download.arrayBuffer()).byteLength).toBeGreaterThan(0)
  })

  it('requeues only failed services and keeps successful service results', async () => {
    const { accessToken } = await registerAndLogin('alice@example.com', 'Alice')
    const { job } = await createJob(accessToken)
    const calls: string[] = []
    const firstFetch: typeof fetch = async (input) => {
      const service = new URL(String(input)).hostname.split('-')[0]!
      calls.push(service)
      if (service === 'kuvert') return new Response('unavailable', { status: 503 })
      return Response.json({ version: '1', service, exportedAt: '2026-08-07T10:00:00.000Z', data: { service } })
    }
    await dispatchExportJobBatch(workerOptions(firstFetch))
    const oldArtifact = Buffer.from(await (await request(
      'GET', `/auth/export-jobs/${job.id}/download`, accessToken,
    )).arrayBuffer())

    const retryResponse = await request('POST', `/auth/export-jobs/${job.id}/retry`, accessToken)

    expect(retryResponse.status).toBe(202)
    expect(await retryResponse.json()).toMatchObject({
      id: job.id,
      status: 'queued',
      downloadUrl: `/auth/export-jobs/${job.id}/download`,
    })
    const retainedArtifact = Buffer.from(await (await request(
      'GET', `/auth/export-jobs/${job.id}/download`, accessToken,
    )).arrayBuffer())
    expect(retainedArtifact).toEqual(oldArtifact)
    calls.length = 0
    await dispatchExportJobBatch(workerOptions(async (input) => {
      const service = new URL(String(input)).hostname.split('-')[0]!
      calls.push(service)
      return Response.json({ version: '1', service, exportedAt: '2026-08-07T10:00:30.000Z', data: { recovered: true } })
    }))
    expect(calls).toEqual(['kuvert'])

    const final = await request('GET', `/auth/export-jobs/${job.id}`, accessToken)
    const body = await final.json() as JobResponse
    expect(body.status).toBe('completed')
    expect(body.services.find(({ service }) => service === 'kuvert')).toMatchObject({
      status: 'succeeded', attempts: 2,
    })
    expect(body.services.filter(({ service }) => service !== 'kuvert').every(({ attempts }) => attempts === 1)).toBe(true)
  })

  it('retries archive assembly without refetching successful snapshots or losing the prior artifact', async () => {
    const { accessToken } = await registerAndLogin('alice@example.com', 'Alice')
    const { job } = await createJob(accessToken)
    await dispatchExportJobBatch(workerOptions(async (input) => {
      const service = new URL(String(input)).hostname.split('-')[0]!
      return service === 'kuvert'
        ? new Response('temporary failure', { status: 503 })
        : Response.json({
          version: '1', service, exportedAt: '2026-08-07T10:00:00.000Z', data: { generation: 1 },
        })
    }))
    const oldArtifact = Buffer.from(await (await request(
      'GET', `/auth/export-jobs/${job.id}/download`, accessToken,
    )).arrayBuffer())

    expect((await request('POST', `/auth/export-jobs/${job.id}/retry`, accessToken)).status).toBe(202)
    await dispatchExportJobBatch({
      ...workerOptions(async (input) => {
        const service = new URL(String(input)).hostname.split('-')[0]!
        return Response.json({
          version: '1', service, exportedAt: '2026-08-07T10:00:30.000Z', data: { generation: 2 },
        })
      }),
      storageQuotaBytes: 1024 * 1024,
    })

    const archiveFailedResponse = await request('GET', `/auth/export-jobs/${job.id}`, accessToken)
    const archiveFailed = await archiveFailedResponse.json() as JobResponse
    expect(archiveFailed).toMatchObject({
      status: 'partial',
      error: 'Export storage quota exceeded',
      downloadUrl: `/auth/export-jobs/${job.id}/download`,
    })
    expect(archiveFailed.services.every(({ status }) => status === 'succeeded')).toBe(true)
    expect(Buffer.from(await (await request(
      'GET', `/auth/export-jobs/${job.id}/download`, accessToken,
    )).arrayBuffer())).toEqual(oldArtifact)

    const archiveRetry = await request('POST', `/auth/export-jobs/${job.id}/retry`, accessToken)
    expect(archiveRetry.status).toBe(202)
    expect(await archiveRetry.json()).toMatchObject({ status: 'queued', error: null })
    let refetches = 0
    await dispatchExportJobBatch(workerOptions(async () => {
      refetches += 1
      throw new Error('archive-only retry must not fetch')
    }))

    expect(refetches).toBe(0)
    const completed = await (await request('GET', `/auth/export-jobs/${job.id}`, accessToken)).json() as JobResponse
    expect(completed.status).toBe('completed')
    expect(completed.error).toBeNull()
    expect(completed.services.map(({ attempts }) => attempts)).toEqual([1, 2, 1, 1, 1, 1, 1])
    const retryAudit = sqlite.prepare(`
      SELECT metadata FROM export_job_events
      WHERE job_id = ? AND event_type = 'retried' ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(job.id) as { metadata: string }
    expect(JSON.parse(retryAudit.metadata)).toEqual({ failedServices: 0, archiveOnly: true })
  })

  it('keeps the existing direct Schlussel export available', async () => {
    const { accessToken } = await registerAndLogin('alice@example.com', 'Alice')

    const response = await request('GET', '/auth/export', accessToken)

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toMatch(/no-store/i)
    expect(response.headers.get('Pragma')).toBe('no-cache')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(await response.json()).toMatchObject({
      scope: 'schlussel-account-only',
      profile: { email: 'alice@example.com' },
    })
  })

  it('records sanitized lifecycle audit metadata without response payloads', async () => {
    const { accessToken } = await registerAndLogin('alice@example.com', 'Alice')
    const { job } = await createJob(accessToken)
    await dispatchExportJobBatch(workerOptions())
    await request('GET', `/auth/export-jobs/${job.id}/download`, accessToken)

    const events = sqlite.prepare(`
      SELECT event_type, metadata FROM export_job_events WHERE job_id = ? ORDER BY created_at, rowid
    `).all(job.id) as Array<{ event_type: string; metadata: string | null }>
    expect(events.map(({ event_type }) => event_type)).toEqual(['created', 'downloaded'])
    expect(JSON.stringify(events)).not.toContain('alice@example.com')
    expect(JSON.stringify(events)).not.toContain('private-payload')
  })
})
