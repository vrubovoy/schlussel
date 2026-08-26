import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeJwt } from 'jose'
import type { Hono } from 'hono'

const testId = randomUUID().slice(0, 8)
const DB_PATH = join(tmpdir(), `schlussel-test-export-worker-${testId}.db`)
const KEYS_DIR = join(tmpdir(), `schlussel-keys-export-worker-${testId}`)
const EXPORT_DIR = join(tmpdir(), `schlussel-export-worker-${testId}`)
const MIGRATIONS_DIR = fileURLToPath(new URL('../db/migrations', import.meta.url))
const OWNER_EMAIL = 'alice@example.com'
const START = new Date('2026-08-07T10:00:00.000Z')

process.env['DATABASE_PATH'] = DB_PATH
process.env['KEYS_DIR'] = KEYS_DIR
process.env['EXPORT_DIR'] = EXPORT_DIR
process.env['JWT_ISSUER'] = 'schlussel'
// All six optional services enabled, matching this file's existing
// assumption that EXPORT_SERVICES always has all seven entries - a
// dedicated test below exercises the topology-aware filtering itself.
process.env['KUVERT_EXPORT_URL'] = 'http://kuvert-backend:3001/exports/me'
process.env['TAFEL_EXPORT_URL'] = 'http://tafel-backend:3002/exports/me'
process.env['ZETTEL_EXPORT_URL'] = 'http://zettel-backend:3003/exports/me'
process.env['GLOCKE_EXPORT_URL'] = 'http://glocke-backend:3004/exports/me'
process.env['SCHRANK_EXPORT_URL'] = 'http://schrank-backend:3005/exports/me'
process.env['HEROLD_EXPORT_URL'] = 'http://herold-backend:3006/exports/me'

type ServiceName = 'schlussel' | 'kuvert' | 'tafel' | 'zettel' | 'glocke' | 'schrank' | 'herold'

interface ServiceDefinition {
  service: ServiceName
  audience: `hof-service:${ServiceName}`
  kind: 'local' | 'http'
  url?: string
}

interface WorkerOptions {
  fetch: typeof fetch
  now: () => Date
  exportDir: string
  requestTimeoutMs: number
  maxResponseBytes: number
  maxConcurrency: number
  leaseMs: number
  artifactTtlMs: number
  storageQuotaBytes?: number
  minFreeBytes?: number
  maxUserRetainedArtifactBytes?: number
  availableBytes?: (path: string) => number
  localSnapshot?: (ownerUserId: string) => Promise<unknown>
}

interface CleanupOptions {
  now: () => Date
  exportDir: string
}

interface JobRow {
  id: string
  owner_user_id: string
  status: string
  archive_path: string | null
  archive_bytes: number | null
  lease_id: string | null
  lease_until: number | null
  expires_at: number | null
  last_error: string | null
}

interface ServiceRow {
  service: ServiceName
  status: string
  attempts: number
  bytes: number | null
  sha256: string | null
  last_error: string | null
  snapshot_path: string | null
}

let app: Hono
let sqlite: import('better-sqlite3').Database
let ownerId: string
let accessToken: string
let EXPORT_SERVICES: readonly ServiceDefinition[]
let createExportServices: (config: Record<string, string | undefined>) => readonly ServiceDefinition[]
let dispatchExportJobBatch: (options: WorkerOptions) => Promise<number>
let cleanupExpiredExports: (options: CleanupOptions) => Promise<number> | number
let createSchlusselSnapshot: (ownerUserId: string, now?: Date) => unknown

beforeAll(async () => {
  mkdirSync(KEYS_DIR, { recursive: true })
  mkdirSync(EXPORT_DIR, { recursive: true })
  const [keysModule, authModule, workerModule, snapshotModule, dbModule, migratorModule, honoModule] =
    await Promise.all([
      import('../utils/keys.js'),
      import('../routes/auth.js'),
      import('../services/exportWorker.js'),
      import('../services/schlusselExport.js'),
      import('../db/index.js'),
      import('drizzle-orm/better-sqlite3/migrator'),
      import('hono'),
    ])

  sqlite = dbModule.sqlite
  EXPORT_SERVICES = workerModule.EXPORT_SERVICES
  createExportServices = workerModule.createExportServices
  dispatchExportJobBatch = workerModule.dispatchExportJobBatch
  cleanupExpiredExports = workerModule.cleanupExpiredExports
  createSchlusselSnapshot = snapshotModule.createSchlusselSnapshot
  await keysModule.initKeys()
  migratorModule.migrate(dbModule.db, { migrationsFolder: MIGRATIONS_DIR })

  const testApp = new honoModule.Hono()
  testApp.route('/auth', authModule.authRouter)
  app = testApp
})

beforeEach(async () => {
  sqlite.exec('DELETE FROM export_job_services')
  sqlite.exec('DELETE FROM export_jobs')
  sqlite.exec('DELETE FROM connected_accounts')
  sqlite.exec('DELETE FROM invites')
  sqlite.exec('DELETE FROM auth_codes')
  sqlite.exec('DELETE FROM refresh_tokens')
  sqlite.exec('DELETE FROM users')
  rmSync(EXPORT_DIR, { recursive: true, force: true })
  mkdirSync(EXPORT_DIR, { recursive: true })

  const register = await jsonRequest('POST', '/auth/register', undefined, {
    email: OWNER_EMAIL,
    password: 'password123',
    name: 'Alice',
  })
  ownerId = ((await register.json()) as { id: string }).id
  const login = await app.request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Schlussel-Frontend': '1' },
    body: JSON.stringify({ email: OWNER_EMAIL, password: 'password123' }),
  })
  accessToken = ((await login.json()) as { accessToken: string }).accessToken
})

afterAll(() => {
  try { sqlite?.close() } catch { /* ignore */ }
  rmSync(DB_PATH, { force: true })
  rmSync(KEYS_DIR, { recursive: true, force: true })
  rmSync(EXPORT_DIR, { recursive: true, force: true })
})

function jsonRequest(method: string, path: string, token?: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function enqueue(): Promise<string> {
  const response = await jsonRequest('POST', '/auth/export-jobs', accessToken, {})
  expect(response.status).toBe(202)
  return ((await response.json()) as { id: string }).id
}

function serviceFromUrl(input: RequestInfo | URL): ServiceName {
  const host = new URL(String(input)).hostname
  return host.slice(0, host.indexOf('-')) as ServiceName
}

function envelope(service: ServiceName, data: unknown = { marker: `${service}-private-payload` }) {
  return {
    version: '1',
    service,
    exportedAt: START.toISOString(),
    data,
  }
}

function okFetch(): typeof fetch {
  return async (input) => Response.json(envelope(serviceFromUrl(input)))
}

function options(overrides: Partial<WorkerOptions> = {}): WorkerOptions {
  return {
    fetch: okFetch(),
    now: () => START,
    exportDir: EXPORT_DIR,
    requestTimeoutMs: 100,
    maxResponseBytes: 1024 * 1024,
    maxConcurrency: 2,
    leaseMs: 1_000,
    artifactTtlMs: 60_000,
    ...overrides,
  }
}

function jobRow(id: string): JobRow {
  return sqlite.prepare(`
    SELECT id, owner_user_id, status, archive_path, archive_bytes,
           lease_id, lease_until, expires_at, last_error
    FROM export_jobs WHERE id = ?
  `).get(id) as JobRow
}

function serviceRows(id: string): ServiceRow[] {
  return sqlite.prepare(`
    SELECT service, status, attempts, bytes, sha256, last_error, snapshot_path
    FROM export_job_services WHERE job_id = ? ORDER BY rowid
  `).all(id) as ServiceRow[]
}

function archive(id: string): Buffer {
  const path = jobRow(id).archive_path
  expect(path).toEqual(expect.any(String))
  return readFileSync(path!)
}

function readZip(buffer: Buffer): Map<string, Buffer> {
  let eocd = -1
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65_557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) throw new Error('ZIP end-of-central-directory record not found')

  const entryCount = buffer.readUInt16LE(eocd + 10)
  let centralOffset = buffer.readUInt32LE(eocd + 16)
  const entries = new Map<string, Buffer>()
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(centralOffset) !== 0x02014b50) throw new Error('Invalid ZIP central directory')
    const method = buffer.readUInt16LE(centralOffset + 10)
    const compressedSize = buffer.readUInt32LE(centralOffset + 20)
    const uncompressedSize = buffer.readUInt32LE(centralOffset + 24)
    const nameLength = buffer.readUInt16LE(centralOffset + 28)
    const extraLength = buffer.readUInt16LE(centralOffset + 30)
    const commentLength = buffer.readUInt16LE(centralOffset + 32)
    const localOffset = buffer.readUInt32LE(centralOffset + 42)
    const name = buffer.subarray(centralOffset + 46, centralOffset + 46 + nameLength).toString('utf8')

    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Invalid ZIP local header')
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength
    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize)
    const contents = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : null
    if (!contents || contents.length !== uncompressedSize) throw new Error(`Unsupported or invalid ZIP entry: ${name}`)
    entries.set(name, contents)
    centralOffset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

describe('export worker service delegation', () => {
  it('builds the local Schlussel snapshot synchronously in one SQLite transaction', () => {
    const snapshot = createSchlusselSnapshot(ownerId, START)
    expect(snapshot).not.toBeInstanceOf(Promise)
    expect(snapshot).toMatchObject({ service: 'schlussel', data: { profile: { email: OWNER_EMAIL } } })
  })

  it('uses a frozen, fixed registry of local Schlussel and internal service endpoints', () => {
    expect(EXPORT_SERVICES).toEqual([
      { service: 'schlussel', audience: 'hof-service:schlussel', kind: 'local' },
      { service: 'kuvert', audience: 'hof-service:kuvert', kind: 'http', url: 'http://kuvert-backend:3001/exports/me' },
      { service: 'tafel', audience: 'hof-service:tafel', kind: 'http', url: 'http://tafel-backend:3002/exports/me' },
      { service: 'zettel', audience: 'hof-service:zettel', kind: 'http', url: 'http://zettel-backend:3003/exports/me' },
      { service: 'glocke', audience: 'hof-service:glocke', kind: 'http', url: 'http://glocke-backend:3004/exports/me' },
      { service: 'schrank', audience: 'hof-service:schrank', kind: 'http', url: 'http://schrank-backend:3005/exports/me' },
      { service: 'herold', audience: 'hof-service:herold', kind: 'http', url: 'http://herold-backend:3006/exports/me' },
    ])
    expect(Object.isFrozen(EXPORT_SERVICES)).toBe(true)
    expect(EXPORT_SERVICES.every((service) => Object.isFrozen(service))).toBe(true)
  })

  it('keeps Schlussel plus only the services with a configured export URL, in a deployment with some disabled', () => {
    const services = createExportServices({
      kuvertUrl: 'http://kuvert-backend:3001/exports/me',
      tafelUrl: undefined,
      zettelUrl: undefined,
      glockeUrl: 'http://glocke-backend:3004/exports/me',
      schrankUrl: undefined,
      heroldUrl: undefined,
    })
    expect(services.map((service) => service.service)).toEqual(['schlussel', 'kuvert', 'glocke'])
  })

  it('keeps only Schlussel when every optional service is disabled', () => {
    const services = createExportServices({
      kuvertUrl: undefined, tafelUrl: undefined, zettelUrl: undefined,
      glockeUrl: undefined, schrankUrl: undefined, heroldUrl: undefined,
    })
    expect(services).toEqual([{ service: 'schlussel', audience: 'hof-service:schlussel', kind: 'local' }])
  })

  it('mints a distinct short-lived export-only JWT for each exact audience', async () => {
    const id = await enqueue()
    const requests: Array<{ service: ServiceName; init?: RequestInit }> = []
    const fetchMock: typeof fetch = async (input, init) => {
      const service = serviceFromUrl(input)
      requests.push({ service, init })
      return Response.json(envelope(service))
    }

    await dispatchExportJobBatch(options({ fetch: fetchMock }))

    expect(requests.map(({ service }) => service).sort()).toEqual([
      'kuvert', 'tafel', 'zettel', 'glocke', 'schrank', 'herold',
    ].sort())
    const tokens = requests.map(({ service, init }) => {
      expect(init?.method).toBe('GET')
      expect(init?.redirect).toBe('error')
      expect(new Headers(init?.headers).get('Accept')).toBe('application/json')
      const authorization = new Headers(init?.headers).get('Authorization')
      expect(authorization).toMatch(/^Bearer /)
      const token = authorization!.slice('Bearer '.length)
      const claims = decodeJwt(token)
      expect(claims).toMatchObject({
        iss: 'schlussel',
        sub: ownerId,
        aud: `hof-service:${service}`,
        scope: 'data:export',
        token_use: 'export',
        job_id: id,
        iat: Math.floor(START.getTime() / 1_000),
        jti: expect.any(String),
      })
      expect(claims.exp! - claims.iat!).toBeGreaterThan(0)
      expect(claims.exp! - claims.iat!).toBeLessThanOrEqual(5 * 60)
      expect(claims).not.toHaveProperty('email')
      expect(claims).not.toHaveProperty('role')
      return token
    })
    expect(new Set(tokens).size).toBe(tokens.length)
    expect(jobRow(id).status).toBe('completed')
  })

  it('mints a fresh token on a failed service retry and does not refetch successes', async () => {
    const id = await enqueue()
    const kuvertTokens: string[] = []
    const attempted: ServiceName[] = []
    const capture = (input: RequestInfo | URL, init?: RequestInit) => {
      const service = serviceFromUrl(input)
      attempted.push(service)
      if (service === 'kuvert') {
        kuvertTokens.push(new Headers(init?.headers).get('Authorization')!.slice('Bearer '.length))
      }
      return service
    }
    await dispatchExportJobBatch(options({
      fetch: async (input, init) => {
        const service = capture(input, init)
        return service === 'kuvert'
          ? new Response('try later', { status: 503 })
          : Response.json(envelope(service))
      },
    }))
    expect(jobRow(id).status).toBe('partial')

    expect((await jsonRequest('POST', `/auth/export-jobs/${id}/retry`, accessToken)).status).toBe(202)
    attempted.length = 0
    await dispatchExportJobBatch(options({
      now: () => new Date(START.getTime() + 30_000),
      fetch: async (input, init) => {
        const service = capture(input, init)
        return Response.json(envelope(service, { recovered: true }))
      },
    }))

    expect(attempted).toEqual(['kuvert'])
    expect(kuvertTokens).toHaveLength(2)
    expect(kuvertTokens[1]).not.toBe(kuvertTokens[0])
    expect(decodeJwt(kuvertTokens[1]!).iat).toBe(decodeJwt(kuvertTokens[0]!).iat! + 30)
    expect(jobRow(id).status).toBe('completed')
  })

  it('rejects redirects rather than following a service-controlled Location', async () => {
    const id = await enqueue()
    const redirects: RequestRedirect[] = []
    const fetchMock: typeof fetch = async (_input, init) => {
      redirects.push(init?.redirect ?? 'follow')
      return new Response(null, { status: 302, headers: { Location: 'https://attacker.invalid/export' } })
    }

    await dispatchExportJobBatch(options({ fetch: fetchMock }))

    expect(redirects).toEqual(['error', 'error', 'error', 'error', 'error', 'error'])
    expect(jobRow(id).status).toBe('partial')
    expect(serviceRows(id).filter(({ service }) => service !== 'schlussel').every(({ status }) => status === 'failed')).toBe(true)
  })

  it('rejects a valid JSON envelope that identifies the wrong service', async () => {
    const id = await enqueue()

    await dispatchExportJobBatch(options({
      fetch: async (input) => Response.json(envelope(
        serviceFromUrl(input) === 'kuvert' ? 'tafel' : serviceFromUrl(input),
      )),
    }))

    expect(jobRow(id).status).toBe('partial')
    expect(serviceRows(id).find(({ service }) => service === 'kuvert')).toMatchObject({
      status: 'failed',
      bytes: null,
      sha256: null,
    })
  })
})

describe('export worker resource bounds and recovery', () => {
  it('bounds HTTP concurrency across remote services', async () => {
    const id = await enqueue()
    let active = 0
    let peak = 0
    const fetchMock: typeof fetch = async (input) => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 10))
      active -= 1
      return Response.json(envelope(serviceFromUrl(input)))
    }

    await dispatchExportJobBatch(options({ fetch: fetchMock, maxConcurrency: 2 }))

    expect(peak).toBe(2)
    expect(jobRow(id).status).toBe('completed')
  })

  it('aborts each request at the configured timeout and stores sanitized errors', async () => {
    const id = await enqueue()
    let aborted = 0
    const fetchMock: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        aborted += 1
        reject(new Error(`secret payload for ${ownerId}`))
      }, { once: true })
    })

    await dispatchExportJobBatch(options({ fetch: fetchMock, requestTimeoutMs: 10 }))

    expect(aborted).toBe(6)
    expect(jobRow(id).status).toBe('partial')
    for (const row of serviceRows(id).filter(({ service }) => service !== 'schlussel')) {
      expect(row.status).toBe('failed')
      expect(row.last_error).toMatch(/timed out|cancelled/i)
      expect(row.last_error).not.toContain(ownerId)
      expect(row.last_error).not.toContain('secret payload')
    }
  })

  it('cancels an oversized response stream without retaining its bytes', async () => {
    const id = await enqueue()
    const cancel = vi.fn()
    const oversized = Buffer.alloc(4097, 'x')
    const fetchMock: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(oversized)
      },
      cancel,
    }), { headers: { 'Content-Type': 'application/json' } })

    await dispatchExportJobBatch(options({ fetch: fetchMock, maxResponseBytes: 4096 }))

    await vi.waitFor(() => expect(cancel).toHaveBeenCalled())
    expect(jobRow(id).status).toBe('partial')
    for (const row of serviceRows(id).filter(({ service }) => service !== 'schlussel')) {
      expect(row).toMatchObject({ status: 'failed', bytes: null, sha256: null })
      expect(row.last_error).toMatch(/too large|size limit/i)
    }
  })

  it('limits all-failure jobs to metadata and no downloadable archive', async () => {
    const id = await enqueue()

    await dispatchExportJobBatch(options({
      fetch: async () => new Response('unavailable', { status: 503 }),
      localSnapshot: async () => { throw new Error(`private ${OWNER_EMAIL}`) },
    }))

    expect(jobRow(id)).toMatchObject({ status: 'failed', archive_path: null, archive_bytes: null })
    expect(serviceRows(id).every(({ status }) => status === 'failed')).toBe(true)
    expect(serviceRows(id).map(({ last_error }) => last_error).join(' ')).not.toContain(OWNER_EMAIL)
    expect((await jsonRequest('GET', `/auth/export-jobs/${id}/download`, accessToken)).status).toBe(409)
  })

  it('recovers a running job after its worker lease expires', async () => {
    const id = await enqueue()
    sqlite.prepare(`
      UPDATE export_jobs
      SET status = 'running', lease_id = 'dead-process', lease_until = ?
      WHERE id = ?
    `).run(START.getTime() - 1, id)

    expect(await dispatchExportJobBatch(options())).toBe(1)

    expect(jobRow(id)).toMatchObject({
      status: 'completed',
      lease_id: null,
      lease_until: null,
    })
    expect(serviceRows(id).every(({ attempts }) => attempts === 1)).toBe(true)
  })

  it('honors cancellation requested while a job is running and starts no more services', async () => {
    const id = await enqueue()
    let release: (() => void) | undefined
    const firstResponse = new Promise<void>((resolve) => { release = resolve })
    const calls: ServiceName[] = []
    const run = dispatchExportJobBatch(options({
      maxConcurrency: 1,
      fetch: async (input) => {
        const service = serviceFromUrl(input)
        calls.push(service)
        await firstResponse
        return Response.json(envelope(service))
      },
    }))
    await vi.waitFor(() => expect(calls).toHaveLength(1))

    const cancellation = await jsonRequest('DELETE', `/auth/export-jobs/${id}`, accessToken)
    expect(cancellation.status).toBe(202)
    release!()
    await run

    expect(calls).toHaveLength(1)
    expect(jobRow(id)).toMatchObject({ status: 'cancelled', archive_path: null })
  })

  it('aborts an active in-process service fetch when the owner cancels', async () => {
    const id = await enqueue()
    let aborted = false
    let fetchStarted = false
    const run = dispatchExportJobBatch(options({
      maxConcurrency: 1,
      requestTimeoutMs: 10_000,
      fetch: (_input, init) => new Promise((_resolve, reject) => {
        fetchStarted = true
        init?.signal?.addEventListener('abort', () => {
          aborted = true
          reject(new Error('private cancellation detail'))
        }, { once: true })
      }),
    }))
    await vi.waitFor(() => expect(fetchStarted).toBe(true))

    await jsonRequest('DELETE', `/auth/export-jobs/${id}`, accessToken)
    await run

    expect(aborted).toBe(true)
    expect(jobRow(id).status).toBe('cancelled')
  })

  it('uses lease-owned service files so a stale worker cannot overwrite or delete a successor result', async () => {
    const id = await enqueue()
    let releaseFirst: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => { releaseFirst = resolve })
    let firstKuvertStarted = false
    const first = dispatchExportJobBatch(options({
      maxConcurrency: 1,
      requestTimeoutMs: 10_000,
      fetch: async (input) => {
        const service = serviceFromUrl(input)
        if (service === 'kuvert') {
          firstKuvertStarted = true
          await blocked
        }
        return Response.json(envelope(service, { worker: 'stale' }))
      },
    }))
    await vi.waitFor(() => expect(firstKuvertStarted).toBe(true))
    sqlite.prepare('UPDATE export_jobs SET lease_until = ? WHERE id = ?').run(START.getTime() - 1, id)

    await dispatchExportJobBatch(options({
      now: () => new Date(START.getTime() + 2_000),
      requestTimeoutMs: 10_000,
      maxConcurrency: 1,
      fetch: async (input) => Response.json(envelope(serviceFromUrl(input), { worker: 'successor' })),
    }))
    const successor = serviceRows(id).find(({ service }) => service === 'kuvert')!
    expect(successor.snapshot_path).toMatch(/kuvert\.[0-9a-f-]+\.json$/)
    expect(JSON.parse(readFileSync(successor.snapshot_path!, 'utf8')).data).toEqual({ worker: 'successor' })

    releaseFirst!()
    await first

    expect(readFileSync(successor.snapshot_path!, 'utf8')).toContain('successor')
    expect(jobRow(id).status).toBe('completed')
  })

  it('fails safely before writes when global quota or free-space reserves are exhausted', async () => {
    const quotaJob = await enqueue()
    await dispatchExportJobBatch(options({ storageQuotaBytes: 128 }))
    expect(jobRow(quotaJob)).toMatchObject({ status: 'failed', archive_path: null })
    expect(serviceRows(quotaJob).some(({ last_error }) => last_error === 'Export storage quota exceeded')).toBe(true)

    sqlite.exec('DELETE FROM export_job_service_attempts; DELETE FROM export_job_services; DELETE FROM export_jobs')
    const freeSpaceJob = await enqueue()
    await dispatchExportJobBatch(options({
      minFreeBytes: 256,
      availableBytes: () => 128,
    }))
    expect(jobRow(freeSpaceJob)).toMatchObject({ status: 'failed', archive_path: null })
    expect(serviceRows(freeSpaceJob).some(({ last_error }) => last_error?.includes('free-space'))).toBe(true)
  })
})

describe('export archive and retention', () => {
  it('writes a safe streamed ZIP manifest with SHA-256 checksums for every successful snapshot', async () => {
    const id = await enqueue()
    await dispatchExportJobBatch(options())

    const entries = readZip(archive(id))
    expect([...entries.keys()]).toEqual([
      'manifest.json', 'README.txt', 'services/schlussel.json', 'services/kuvert.json',
      'services/tafel.json', 'services/zettel.json', 'services/glocke.json',
      'services/schrank.json', 'services/herold.json',
    ])
    for (const name of entries.keys()) {
      expect(name).not.toContain('..')
      expect(name).not.toContain('\\')
    }

    const manifest = JSON.parse(entries.get('manifest.json')!.toString('utf8')) as {
      version: string
      jobId: string
      status: string
      createdAt: string
      completedAt: string
      services: Array<{
        service: ServiceName
        status: string
        file: string | null
        bytes: number | null
        sha256: string | null
        error: string | null
      }>
    }
    expect(manifest).toMatchObject({
      version: '1',
      jobId: id,
      status: 'completed',
      createdAt: expect.any(String),
      completedAt: START.toISOString(),
    })
    expect(manifest).not.toHaveProperty('ownerId')
    expect(manifest.services.map(({ service }) => service)).toEqual([
      'schlussel', 'kuvert', 'tafel', 'zettel', 'glocke', 'schrank', 'herold',
    ])
    for (const service of manifest.services) {
      const file = `services/${service.service}.json`
      const payload = entries.get(file)!
      expect(service).toMatchObject({
        service: service.service,
        status: 'succeeded',
        file,
        bytes: payload.byteLength,
        sha256: createHash('sha256').update(payload).digest('hex'),
        error: null,
      })
    }
    expect(JSON.parse(entries.get('services/schlussel.json')!.toString('utf8'))).toMatchObject({
      service: 'schlussel',
      data: { profile: { email: OWNER_EMAIL } },
    })
  })

  it('produces a downloadable partial archive whose manifest records failures without fake files', async () => {
    const id = await enqueue()
    await dispatchExportJobBatch(options({
      fetch: async (input) => {
        const service = serviceFromUrl(input)
        return service === 'schrank' || service === 'herold'
          ? new Response('database password=do-not-store', { status: 503 })
          : Response.json(envelope(service))
      },
    }))

    expect(jobRow(id).status).toBe('partial')
    const entries = readZip(archive(id))
    expect(entries.has('services/schrank.json')).toBe(false)
    expect(entries.has('services/herold.json')).toBe(false)
    expect(entries.has('errors/schrank.json')).toBe(true)
    expect(entries.has('errors/herold.json')).toBe(true)
    const manifest = JSON.parse(entries.get('manifest.json')!.toString('utf8')) as {
      status: string
      services: Array<Record<string, unknown>>
    }
    expect(manifest.status).toBe('partial')
    expect(manifest.services.find(({ service }) => service === 'schrank')).toMatchObject({
      service: 'schrank',
      status: 'failed',
      file: null,
      bytes: null,
      sha256: null,
      error: 'Service returned HTTP 503',
      errorFile: 'errors/schrank.json',
    })
    expect(manifest.services.find(({ service }) => service === 'herold')).toMatchObject({
      service: 'herold',
      status: 'failed',
      errorFile: 'errors/herold.json',
    })
    expect(JSON.stringify(manifest)).not.toContain('database password')
    expect((await jsonRequest('GET', `/auth/export-jobs/${id}/download`, accessToken)).status).toBe(200)
  })

  it('persists only job metadata in SQLite, never service payloads or ZIP bytes', async () => {
    const marker = 'unique-private-payload-not-for-sqlite'
    const id = await enqueue()
    await dispatchExportJobBatch(options({
      fetch: async (input) => Response.json(envelope(serviceFromUrl(input), { marker })),
    }))

    for (const table of ['export_jobs', 'export_job_services', 'export_job_service_attempts']) {
      const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string }>
      expect(columns.map(({ name }) => name)).not.toEqual(expect.arrayContaining([
        expect.stringMatching(/payload|content|body|archive_blob/i),
      ]))
      expect(columns.every(({ type }) => type.toUpperCase() !== 'BLOB')).toBe(true)
      const rows = sqlite.prepare(`SELECT * FROM ${table}`).all()
      expect(JSON.stringify(rows)).not.toContain(marker)
      expect(JSON.stringify(rows)).not.toContain(OWNER_EMAIL)
    }
    expect([...readZip(archive(id)).values()].some((contents) => contents.includes(marker))).toBe(true)
  })

  it('uses private directory/file modes and removes expired artifacts at the injected clock', async () => {
    const id = await enqueue()
    await dispatchExportJobBatch(options())
    const row = jobRow(id)
    const archivePath = row.archive_path!
    const jobDirectory = join(archivePath, '..')
    expect(isAbsolute(archivePath)).toBe(true)
    expect(relative(EXPORT_DIR, archivePath)).not.toMatch(/^\.\.(?:\/|$)/)
    expect(statSync(EXPORT_DIR).mode & 0o777).toBe(0o700)
    expect(statSync(jobDirectory).mode & 0o777).toBe(0o700)
    expect(statSync(archivePath).mode & 0o777).toBe(0o600)

    expect(await cleanupExpiredExports({
      now: () => new Date(row.expires_at! - 1),
      exportDir: EXPORT_DIR,
    })).toBe(0)
    expect(statSync(archivePath).isFile()).toBe(true)

    expect(await cleanupExpiredExports({
      now: () => new Date(row.expires_at!),
      exportDir: EXPORT_DIR,
    })).toBe(1)
    expect(jobRow(id)).toMatchObject({
      status: 'expired',
      archive_path: null,
      archive_bytes: null,
    })
    expect(() => statSync(jobDirectory)).toThrow()
    expect((await jsonRequest('GET', `/auth/export-jobs/${id}/download`, accessToken)).status).toBe(410)
    expect((await jsonRequest('POST', `/auth/export-jobs/${id}/retry`, accessToken)).status).toBe(409)
  })
})
