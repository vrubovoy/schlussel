import { createId } from '@paralleldrive/cuid2'
import { randomUUID } from 'node:crypto'
import { createReadStream, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { Hono } from 'hono'
import type { User } from '../db/schema.js'
import { sqlite } from '../db/index.js'
import { loadExportConfig } from '../config.js'
import { cancelActiveExportJob, EXPORT_SERVICES, isSafeArchivePath } from '../services/exportWorker.js'

type AuthenticateBearer = (
  context: { req: { header: (name: string) => string | undefined } },
) => Promise<User | null>

interface JobRow {
  id: string
  owner_user_id: string
  status: 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'expired'
  created_at: number
  started_at: number | null
  completed_at: number | null
  expires_at: number | null
  archive_path: string | null
  archive_bytes: number | null
  last_error: string | null
}

interface ServiceRow {
  service: string
  status: string
  attempts: number
  bytes: number | null
  sha256: string | null
  last_error: string | null
}

const config = loadExportConfig()

function jobForOwner(jobId: string, ownerUserId: string): JobRow | undefined {
  return sqlite.prepare(`
    SELECT id, owner_user_id, status, created_at, started_at, completed_at,
           expires_at, archive_path, archive_bytes, last_error
    FROM export_jobs WHERE id = ? AND owner_user_id = ?
  `).get(jobId, ownerUserId) as JobRow | undefined
}

function iso(value: number | null): string | null {
  return value == null ? null : new Date(value).toISOString()
}

function jobJson(row: JobRow) {
  const services = sqlite.prepare(`
    SELECT service, status, attempts, bytes, sha256, last_error
    FROM export_job_services WHERE job_id = ? ORDER BY rowid
  `).all(row.id) as ServiceRow[]
  return {
    id: row.id,
    status: row.status,
    createdAt: iso(row.created_at),
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    expiresAt: iso(row.expires_at),
    downloadUrl: row.archive_path && !['cancelled', 'expired', 'failed'].includes(row.status)
      ? `/auth/export-jobs/${row.id}/download`
      : null,
    error: row.last_error,
    services: services.map((service) => ({
      service: service.service,
      status: service.status,
      attempts: service.attempts,
      bytes: service.bytes,
      sha256: service.sha256,
      error: service.last_error,
    })),
  }
}

function audit(jobId: string, ownerUserId: string, eventType: string, metadata?: object) {
  sqlite.prepare(`
    INSERT INTO export_job_events (id, job_id, owner_user_id, event_type, created_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), jobId, ownerUserId, eventType, Date.now(), metadata ? JSON.stringify(metadata) : null)
}

function createOrGetActiveJob(ownerUserId: string):
  | { kind: 'job'; job: JobRow }
  | { kind: 'cooldown'; retryAfterSeconds: number }
  | { kind: 'retained_limit' }
  | { kind: 'artifact_limit' } {
  return sqlite.transaction(() => {
    const existing = sqlite.prepare(`
      SELECT id, owner_user_id, status, created_at, started_at, completed_at,
             expires_at, archive_path, archive_bytes, last_error
      FROM export_jobs
      WHERE owner_user_id = ? AND status IN ('queued', 'running')
      LIMIT 1
    `).get(ownerUserId) as JobRow | undefined
    if (existing) return { kind: 'job' as const, job: existing }

    const now = Date.now()
    const latest = sqlite.prepare(`
      SELECT created_at FROM export_jobs WHERE owner_user_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(ownerUserId) as { created_at: number } | undefined
    if (latest && now - latest.created_at < config.userCooldownMs) {
      return {
        kind: 'cooldown' as const,
        retryAfterSeconds: Math.max(1, Math.ceil((config.userCooldownMs - (now - latest.created_at)) / 1000)),
      }
    }
    const retained = sqlite.prepare(`
      SELECT count(*) AS jobs, COALESCE(SUM(archive_bytes), 0) AS bytes
      FROM export_jobs WHERE owner_user_id = ? AND status != 'expired'
    `).get(ownerUserId) as { jobs: number; bytes: number }
    if (retained.jobs >= config.maxRetainedJobsPerUser) return { kind: 'retained_limit' as const }
    if (retained.bytes >= config.maxRetainedArtifactBytesPerUser) return { kind: 'artifact_limit' as const }

    const id = createId()
    const createdAt = now
    sqlite.prepare(`
      INSERT INTO export_jobs (id, owner_user_id, status, created_at)
      VALUES (?, ?, 'queued', ?)
    `).run(id, ownerUserId, createdAt)
    const insertService = sqlite.prepare(`
      INSERT INTO export_job_services (job_id, service, status, attempts)
      VALUES (?, ?, 'pending', 0)
    `)
    for (const service of EXPORT_SERVICES) insertService.run(id, service.service)
    const job: JobRow = {
      id,
      owner_user_id: ownerUserId,
      status: 'queued' as const,
      created_at: createdAt,
      started_at: null,
      completed_at: null,
      expires_at: null,
      archive_path: null,
      archive_bytes: null,
      last_error: null,
    }
    audit(id, ownerUserId, 'created', { services: EXPORT_SERVICES.length })
    return { kind: 'job' as const, job }
  }).immediate()
}

export function createExportJobsRouter(authenticateBearer: AuthenticateBearer) {
  const router = new Hono()

  router.use('*', async (c, next) => {
    await next()
    c.header('Cache-Control', 'no-store, private')
    c.header('Pragma', 'no-cache')
    c.header('X-Content-Type-Options', 'nosniff')
  })

  router.post('/export-jobs', async (c) => {
    const user = await authenticateBearer(c)
    if (!user) return c.json({ error: 'Unauthorized' }, 401)
    let body: unknown = {}
    try {
      body = await c.req.json()
    } catch {
      // An omitted body is equivalent to the documented empty object.
    }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length > 0) {
      return c.json({ error: 'Export jobs do not accept service URLs or other options' }, 400)
    }
    const result = createOrGetActiveJob(user.id)
    if (result.kind === 'cooldown') {
      c.header('Retry-After', result.retryAfterSeconds.toString())
      return c.json({ error: 'Export creation cooldown is active' }, 429)
    }
    if (result.kind === 'retained_limit') return c.json({ error: 'Too many retained export jobs' }, 429)
    if (result.kind === 'artifact_limit') return c.json({ error: 'Retained export artifact limit reached' }, 429)
    c.header('Location', `/auth/export-jobs/${result.job.id}`)
    return c.json(jobJson(result.job), 202)
  })

  router.get('/export-jobs/:id', async (c) => {
    const user = await authenticateBearer(c)
    if (!user) return c.json({ error: 'Unauthorized' }, 401)
    const job = jobForOwner(c.req.param('id'), user.id)
    if (!job) return c.json({ error: 'Not found' }, 404)
    return c.json(jobJson(job))
  })

  router.delete('/export-jobs/:id', async (c) => {
    const user = await authenticateBearer(c)
    if (!user) return c.json({ error: 'Unauthorized' }, 401)
    const id = c.req.param('id')
    const result = sqlite.transaction(() => {
      const job = jobForOwner(id, user.id)
      if (!job) return { kind: 'missing' as const }
      if (job.status === 'cancelled') return { kind: 'cancelled' as const, removeNow: false, job }
      if (!['queued', 'running'].includes(job.status)) return { kind: 'conflict' as const }
      const now = Date.now()
      const expiresAt = now + config.artifactTtlMs
      sqlite.prepare(`
        UPDATE export_jobs
        SET status = 'cancelled', completed_at = ?, expires_at = ?, archive_path = NULL,
            archive_bytes = NULL, lease_id = NULL, lease_until = NULL
        WHERE id = ? AND owner_user_id = ? AND status IN ('queued', 'running')
      `).run(now, expiresAt, id, user.id)
      sqlite.prepare(`
        UPDATE export_job_services SET status = 'cancelled', completed_at = ?
        WHERE job_id = ? AND status IN ('pending', 'running')
      `).run(now, id)
      sqlite.prepare(`
        UPDATE export_job_service_attempts
        SET status = 'cancelled', completed_at = ?, error = 'Export job was cancelled'
        WHERE job_id = ? AND status = 'running'
      `).run(now, id)
      audit(id, user.id, 'cancelled')
      return { kind: 'cancelled' as const, removeNow: job.status === 'queued', job: jobForOwner(id, user.id)! }
    }).immediate()
    if (result.kind === 'missing') return c.json({ error: 'Not found' }, 404)
    if (result.kind === 'conflict') return c.json({ error: 'Export job cannot be cancelled' }, 409)
    cancelActiveExportJob(result.job.id)
    if (result.removeNow) rmSync(join(resolve(config.exportDir), result.job.id), { recursive: true, force: true })
    return c.json(jobJson(result.job), 202)
  })

  router.post('/export-jobs/:id/retry', async (c) => {
    const user = await authenticateBearer(c)
    if (!user) return c.json({ error: 'Unauthorized' }, 401)
    const id = c.req.param('id')
    const result = sqlite.transaction(() => {
      const job = jobForOwner(id, user.id)
      if (!job) return { kind: 'missing' as const }
      if (!['partial', 'failed'].includes(job.status)) return { kind: 'conflict' as const }
      const active = sqlite.prepare(`
        SELECT id FROM export_jobs
        WHERE owner_user_id = ? AND status IN ('queued', 'running') AND id != ?
      `).get(user.id, id)
      if (active) return { kind: 'active' as const }
      const failed = sqlite.prepare(`
        SELECT count(*) AS count FROM export_job_services WHERE job_id = ? AND status = 'failed'
      `).get(id) as { count: number }
      const archiveOnly = failed.count === 0 && job.last_error !== null
      if (failed.count === 0 && !archiveOnly) return { kind: 'conflict' as const }

      if (!archiveOnly) {
        sqlite.prepare(`
          UPDATE export_job_services
          SET status = 'pending', bytes = NULL, sha256 = NULL, last_error = NULL,
              snapshot_path = NULL, started_at = NULL, completed_at = NULL
          WHERE job_id = ? AND status = 'failed'
        `).run(id)
      }
      sqlite.prepare(`
        UPDATE export_jobs
        SET status = 'queued', completed_at = NULL, expires_at = NULL,
            last_error = NULL, lease_id = NULL, lease_until = NULL
        WHERE id = ? AND owner_user_id = ?
      `).run(id, user.id)
      audit(id, user.id, 'retried', { failedServices: failed.count, archiveOnly })
      return { kind: 'queued' as const, job: jobForOwner(id, user.id)! }
    }).immediate()
    if (result.kind === 'missing') return c.json({ error: 'Not found' }, 404)
    if (result.kind === 'conflict') return c.json({ error: 'Export job has no failed services to retry' }, 409)
    if (result.kind === 'active') return c.json({ error: 'Another export job is active' }, 409)
    c.header('Location', `/auth/export-jobs/${id}`)
    return c.json(jobJson(result.job), 202)
  })

  router.get('/export-jobs/:id/download', async (c) => {
    const user = await authenticateBearer(c)
    if (!user) return c.json({ error: 'Unauthorized' }, 401)
    const job = jobForOwner(c.req.param('id'), user.id)
    if (!job) return c.json({ error: 'Not found' }, 404)
    if (job.status === 'expired') return c.json({ error: 'Export artifact expired' }, 410)
    if (['cancelled', 'failed'].includes(job.status) || !job.archive_path) {
      return c.json({ error: 'Export artifact is not available' }, 409)
    }

    audit(job.id, user.id, 'downloaded', { status: job.status, bytes: job.archive_bytes })
    if (!isSafeArchivePath(config.exportDir, job.archive_path) || !existsSync(job.archive_path)) {
      sqlite.prepare(`
        UPDATE export_jobs SET status = 'expired', archive_path = NULL, archive_bytes = NULL
        WHERE id = ? AND owner_user_id = ?
      `).run(job.id, user.id)
      return c.json({ error: 'Export artifact expired' }, 410)
    }

    c.header('Content-Type', 'application/zip')
    c.header('Content-Disposition', `attachment; filename="hof-export-${job.id}.zip"`)
    const stream = Readable.toWeb(createReadStream(job.archive_path)) as ReadableStream<Uint8Array>
    return c.body(stream)
  })

  return router
}
