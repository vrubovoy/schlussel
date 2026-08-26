import { exportEnvelopeSchema } from '@zudar107/schloss-server-kit'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  createWriteStream,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { Transform } from 'node:stream'
import { ZipFile } from 'yazl'
import { loadExportConfig, type ExportConfig } from '../config.js'
import { sqlite } from '../db/index.js'
import { signExportToken } from '../utils/jwt.js'
import { createSchlusselSnapshot } from './schlusselExport.js'

export type ExportServiceName = 'schlussel' | 'kuvert' | 'tafel' | 'zettel' | 'glocke' | 'schrank' | 'herold'

export interface ExportServiceDefinition {
  service: ExportServiceName
  audience: `hof-service:${ExportServiceName}`
  kind: 'local' | 'http'
  url?: string
}

// Schlussel (local) is mandatory core and always present. Every other
// service only joins the registry if its export URL is configured - an
// operator who hasn't enabled a service (e.g. Schrank) never has export
// jobs dispatch to it, and it never appears in a job's manifest at all
// (not as a failure - see dispatchExportJobBatch/writeZip).
export function createExportServices(config: Pick<
  ExportConfig,
  'kuvertUrl' | 'tafelUrl' | 'zettelUrl' | 'glockeUrl' | 'schrankUrl' | 'heroldUrl'
>) {
  const optional: Array<[Exclude<ExportServiceName, 'schlussel'>, string | undefined]> = [
    ['kuvert', config.kuvertUrl],
    ['tafel', config.tafelUrl],
    ['zettel', config.zettelUrl],
    ['glocke', config.glockeUrl],
    ['schrank', config.schrankUrl],
    ['herold', config.heroldUrl],
  ]
  const definitions: ExportServiceDefinition[] = [
    Object.freeze({ service: 'schlussel', audience: 'hof-service:schlussel', kind: 'local' }),
  ]
  for (const [service, url] of optional) {
    if (url !== undefined) {
      definitions.push(Object.freeze({ service, audience: `hof-service:${service}`, kind: 'http', url }))
    }
  }
  return Object.freeze(definitions satisfies ExportServiceDefinition[])
}

const defaultConfig = loadExportConfig()
export const EXPORT_SERVICES = createExportServices(defaultConfig)

const DEFAULT_README = `Hof platform data export

This archive contains snapshots returned by Hof services for your account.
See manifest.json for checksums, byte counts, timestamps, and failures.
Files under errors/ contain sanitized diagnostics and no service response bodies.
`

interface ExportJobRow {
  id: string
  owner_user_id: string
  status: string
  created_at: number
  started_at: number | null
  completed_at: number | null
  expires_at: number | null
  archive_path: string | null
  archive_bytes: number | null
  lease_id: string | null
  lease_until: number | null
  last_error: string | null
}

interface ExportServiceRow {
  job_id: string
  service: ExportServiceName
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  attempts: number
  bytes: number | null
  sha256: string | null
  snapshot_path: string | null
  last_error: string | null
  started_at: number | null
  completed_at: number | null
}

export interface DispatchExportJobOptions {
  fetch?: typeof fetch
  now?: () => Date
  exportDir?: string
  requestTimeoutMs?: number
  maxResponseBytes?: number
  maxAggregateBytes?: number
  maxConcurrency?: number
  leaseMs?: number
  artifactTtlMs?: number
  storageQuotaBytes?: number
  minFreeBytes?: number
  maxUserRetainedArtifactBytes?: number
  availableBytes?: (path: string) => number
  localSnapshot?: (ownerUserId: string) => unknown | Promise<unknown>
  services?: readonly ExportServiceDefinition[]
  signal?: AbortSignal
}

export interface CleanupExportOptions {
  now?: () => Date
  exportDir?: string
}

class SafeExportError extends Error {}

const activeRequests = new Map<string, Set<AbortController>>()

export function cancelActiveExportJob(jobId: string) {
  for (const controller of activeRequests.get(jobId) ?? []) controller.abort()
}

function ensurePrivateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  chmodSync(path, 0o700)
}

function safeJobDirectory(exportDir: string, jobId: string): string {
  const root = resolve(exportDir)
  const directory = resolve(root, jobId)
  if (relative(root, directory).startsWith('..') || directory === root) {
    throw new Error('Invalid export job path')
  }
  return directory
}

function removeFile(path: string | null | undefined) {
  if (!path) return
  try {
    rmSync(path, { force: true })
  } catch {
    // Cleanup is retried by retention sweeps; state transitions must not leak errors.
  }
}

function claimNextJob(nowMs: number, leaseId: string, leaseMs: number): ExportJobRow | undefined {
  return sqlite.transaction(() => {
    const row = sqlite.prepare(`
      SELECT * FROM export_jobs
      WHERE status = 'queued'
         OR (status = 'running' AND (lease_until IS NULL OR lease_until <= ?))
      ORDER BY created_at, id
      LIMIT 1
    `).get(nowMs) as ExportJobRow | undefined
    if (!row) return undefined

    if (row.status === 'running') {
      sqlite.prepare(`
        UPDATE export_job_service_attempts
        SET status = 'failed', completed_at = ?, error = 'Worker interrupted before completion'
        WHERE job_id = ? AND status = 'running'
      `).run(nowMs, row.id)
      sqlite.prepare(`
        UPDATE export_job_services
        SET status = 'pending', last_error = 'Worker interrupted before completion'
        WHERE job_id = ? AND status = 'running'
      `).run(row.id)
    }

    sqlite.prepare(`
      UPDATE export_jobs
      SET status = 'running', started_at = COALESCE(started_at, ?),
          lease_id = ?, lease_until = ?, completed_at = NULL, expires_at = NULL,
          last_error = NULL
      WHERE id = ?
    `).run(nowMs, leaseId, nowMs + leaseMs, row.id)
    return { ...row, status: 'running', started_at: row.started_at ?? nowMs, lease_id: leaseId }
  }).immediate()
}

function ownsLease(jobId: string, leaseId: string): boolean {
  return sqlite.prepare(`
    SELECT 1 FROM export_jobs WHERE id = ? AND status = 'running' AND lease_id = ?
  `).get(jobId, leaseId) !== undefined
}

function renewLease(jobId: string, leaseId: string, until: number) {
  sqlite.prepare(`
    UPDATE export_jobs SET lease_until = ?
    WHERE id = ? AND status = 'running' AND lease_id = ?
  `).run(until, jobId, leaseId)
}

function startServiceAttempt(jobId: string, leaseId: string, service: ExportServiceName, nowMs: number) {
  return sqlite.transaction(() => {
    if (!ownsLease(jobId, leaseId)) return null
    const row = sqlite.prepare(`
      SELECT attempts FROM export_job_services WHERE job_id = ? AND service = ? AND status != 'succeeded'
    `).get(jobId, service) as { attempts: number } | undefined
    if (!row) return null
    const attempt = row.attempts + 1
    const attemptId = randomUUID()
    sqlite.prepare(`
      UPDATE export_job_services
      SET status = 'running', attempts = ?, started_at = ?, completed_at = NULL,
          bytes = NULL, sha256 = NULL, snapshot_path = NULL, last_error = NULL
      WHERE job_id = ? AND service = ?
    `).run(attempt, nowMs, jobId, service)
    sqlite.prepare(`
      INSERT INTO export_job_service_attempts
        (id, job_id, service, attempt, status, started_at)
      VALUES (?, ?, ?, ?, 'running', ?)
    `).run(attemptId, jobId, service, attempt, nowMs)
    return { attempt, attemptId }
  }).immediate()
}

function finishServiceAttempt(
  jobId: string,
  leaseId: string,
  service: ExportServiceName,
  attemptId: string,
  nowMs: number,
  result: { status: 'succeeded'; bytes: number; sha256: string; snapshotPath: string } | { status: 'failed'; error: string },
): boolean {
  return sqlite.transaction(() => {
    if (!ownsLease(jobId, leaseId)) return false
    if (result.status === 'succeeded') {
      sqlite.prepare(`
        UPDATE export_job_services
        SET status = 'succeeded', bytes = ?, sha256 = ?, snapshot_path = ?, last_error = NULL, completed_at = ?
        WHERE job_id = ? AND service = ? AND status = 'running'
      `).run(result.bytes, result.sha256, result.snapshotPath, nowMs, jobId, service)
      sqlite.prepare(`
        UPDATE export_job_service_attempts
        SET status = 'succeeded', completed_at = ?, bytes = ?, sha256 = ?
        WHERE id = ? AND status = 'running'
      `).run(nowMs, result.bytes, result.sha256, attemptId)
    } else {
      sqlite.prepare(`
        UPDATE export_job_services
        SET status = 'failed', bytes = NULL, sha256 = NULL, snapshot_path = NULL, last_error = ?, completed_at = ?
        WHERE job_id = ? AND service = ? AND status = 'running'
      `).run(result.error, nowMs, jobId, service)
      sqlite.prepare(`
        UPDATE export_job_service_attempts
        SET status = 'failed', completed_at = ?, error = ?
        WHERE id = ? AND status = 'running'
      `).run(nowMs, result.error, attemptId)
    }
    return true
  }).immediate()
}

function sanitizedError(error: unknown, service: ExportServiceName, aborted: boolean): string {
  if (error instanceof SafeExportError) return error.message
  if (aborted) return 'Service request timed out or was cancelled'
  return service === 'schlussel' ? 'Schlussel export failed' : 'Service request failed'
}

function writePrivateFile(path: string, chunks: readonly Uint8Array[]) {
  const descriptor = openSync(path, 'wx', 0o600)
  try {
    for (const chunk of chunks) writeSync(descriptor, chunk)
  } finally {
    closeSync(descriptor)
  }
}

function directoryBytes(directory: string): number {
  let bytes = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) bytes += directoryBytes(path)
    else if (entry.isFile()) bytes += statSync(path).size
  }
  return bytes
}

function storageBudget(
  exportDir: string,
  quotaBytes: number,
  minFreeBytes: number,
  availableBytes: (path: string) => number,
) {
  let usage = directoryBytes(exportDir)
  const check = (bytes: number) => {
    const free = availableBytes(exportDir)
    if (usage + bytes > quotaBytes) throw new SafeExportError('Export storage quota exceeded')
    if (free - bytes < minFreeBytes) throw new SafeExportError('Export storage free-space reserve reached')
  }
  return {
    check,
    reserve(bytes: number) {
      check(bytes)
      usage += bytes
    },
    release(bytes: number) {
      usage = Math.max(0, usage - bytes)
    },
  }
}

async function writeZip(
  temporaryPath: string,
  manifest: object,
  rows: ExportServiceRow[],
  directory: string,
  completedAt: Date,
  reserveStorage: (bytes: number) => void,
): Promise<number> {
  const zip = new ZipFile()
  zip.addBuffer(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), 'manifest.json', { mtime: completedAt })
  zip.addBuffer(Buffer.from(DEFAULT_README), 'README.txt', { mtime: completedAt })
  for (const row of rows) {
    if (row.status === 'succeeded') {
      if (!row.snapshot_path || !isSafeArchivePath(directory, row.snapshot_path)) {
        throw new SafeExportError('Successful service snapshot is unavailable')
      }
      zip.addFile(row.snapshot_path, `services/${row.service}.json`, { mtime: completedAt })
    } else if (row.status === 'failed') {
      zip.addBuffer(Buffer.from(`${JSON.stringify({
        service: row.service,
        status: row.status,
        attempts: row.attempts,
        error: row.last_error,
        completedAt: row.completed_at == null ? null : new Date(row.completed_at).toISOString(),
      }, null, 2)}\n`), `errors/${row.service}.json`, { mtime: completedAt })
    }
  }

  let written = 0
  await new Promise<void>((resolvePromise, reject) => {
    const output = createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 })
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        try {
          reserveStorage(chunk.byteLength)
          written += chunk.byteLength
          callback(null, chunk)
        } catch (error) {
          callback(error as Error)
        }
      },
    })
    let settled = false
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      zip.outputStream.unpipe(limiter)
      ;(zip.outputStream as typeof zip.outputStream & { destroy?: () => void }).destroy?.()
      limiter.destroy()
      output.destroy()
      reject(error)
    }
    output.once('close', () => {
      if (settled) return
      settled = true
      resolvePromise()
    })
    output.once('error', fail)
    limiter.once('error', fail)
    zip.outputStream.once('error', fail)
    zip.outputStream.pipe(limiter).pipe(output)
    zip.end()
  })
  return written
}

export async function dispatchExportJobBatch(options: DispatchExportJobOptions = {}): Promise<number> {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const now = options.now ?? (() => new Date())
  const exportDir = resolve(options.exportDir ?? defaultConfig.exportDir)
  const requestTimeoutMs = options.requestTimeoutMs ?? defaultConfig.requestTimeoutMs
  const maxResponseBytes = options.maxResponseBytes ?? defaultConfig.maxResponseBytes
  const maxAggregateBytes = options.maxAggregateBytes ?? defaultConfig.maxAggregateBytes
  const maxConcurrency = options.maxConcurrency ?? defaultConfig.maxConcurrency
  const leaseMs = options.leaseMs ?? defaultConfig.leaseMs
  const artifactTtlMs = options.artifactTtlMs ?? defaultConfig.artifactTtlMs
  const storageQuotaBytes = options.storageQuotaBytes ?? defaultConfig.storageQuotaBytes
  const minFreeBytes = options.minFreeBytes ?? defaultConfig.minFreeBytes
  const maxUserRetainedArtifactBytes = options.maxUserRetainedArtifactBytes ?? defaultConfig.maxRetainedArtifactBytesPerUser
  const services = options.services ?? EXPORT_SERVICES
  for (const [name, value] of Object.entries({
    requestTimeoutMs, maxResponseBytes, maxAggregateBytes, maxConcurrency, leaseMs,
    artifactTtlMs, storageQuotaBytes, minFreeBytes, maxUserRetainedArtifactBytes,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  }
  if (maxAggregateBytes < maxResponseBytes) throw new Error('maxAggregateBytes must be at least maxResponseBytes')

  ensurePrivateDirectory(exportDir)
  const claimedAt = now().getTime()
  const leaseId = randomUUID()
  const claimedJob = claimNextJob(claimedAt, leaseId, leaseMs)
  if (!claimedJob) return 0
  const job: ExportJobRow = claimedJob

  const directory = safeJobDirectory(exportDir, job.id)
  ensurePrivateDirectory(directory)
  const retainedArchive = job.archive_path ? resolve(job.archive_path) : null
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isFile() && path !== retainedArchive && (entry.name.startsWith('export-') || entry.name.endsWith('.tmp'))) {
      removeFile(path)
    }
  }
  const storage = storageBudget(
    exportDir,
    storageQuotaBytes,
    minFreeBytes,
    options.availableBytes ?? ((path) => {
      const stats = statfsSync(path)
      return Number(stats.bavail) * Number(stats.bsize)
    }),
  )
  let aggregateBytes = (sqlite.prepare(`
    SELECT COALESCE(SUM(bytes), 0) AS bytes FROM export_job_services
    WHERE job_id = ? AND status = 'succeeded'
  `).get(job.id) as { bytes: number }).bytes

  const heartbeat = setInterval(() => renewLease(job.id, leaseId, now().getTime() + leaseMs), Math.max(50, Math.floor(leaseMs / 3)))
  heartbeat.unref()

  async function attemptService(definition: ExportServiceDefinition) {
    if (options.signal?.aborted || !ownsLease(job.id, leaseId)) return
    renewLease(job.id, leaseId, now().getTime() + leaseMs)
    const started = startServiceAttempt(job.id, leaseId, definition.service, now().getTime())
    if (!started) return

    const temporaryPath = join(directory, `${definition.service}.${leaseId}.tmp`)
    const finalPath = join(directory, `${definition.service}.${leaseId}.json`)
    removeFile(temporaryPath)
    let attemptBytes = 0
    let controller: AbortController | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    let externalAbort: (() => void) | undefined
    const releaseBudget = () => {
      aggregateBytes -= attemptBytes
      attemptBytes = 0
    }
    const reserve = (bytes: number) => {
      if (attemptBytes + bytes > maxResponseBytes) throw new SafeExportError('Service response exceeded its size limit')
      if (aggregateBytes + bytes > maxAggregateBytes) throw new SafeExportError('Export exceeded its aggregate size limit')
      storage.reserve(bytes)
      attemptBytes += bytes
      aggregateBytes += bytes
    }

    try {
      let contents: Buffer
      if (definition.kind === 'local') {
        const snapshot = options.localSnapshot
          ? await options.localSnapshot(job.owner_user_id)
          : await createSchlusselSnapshot(job.owner_user_id, now())
        contents = Buffer.from(`${JSON.stringify(snapshot)}\n`)
        reserve(contents.byteLength)
        writePrivateFile(temporaryPath, [contents])
      } else {
        controller = new AbortController()
        externalAbort = () => controller?.abort()
        if (options.signal?.aborted) externalAbort()
        else options.signal?.addEventListener('abort', externalAbort, { once: true })
        const controllers = activeRequests.get(job.id) ?? new Set<AbortController>()
        controllers.add(controller)
        activeRequests.set(job.id, controllers)
        timeout = setTimeout(externalAbort, requestTimeoutMs)
        timeout.unref()
        const token = await signExportToken(job.owner_user_id, definition.service, job.id, now())
        if (!ownsLease(job.id, leaseId) || controller.signal.aborted) {
          throw new SafeExportError('Export job was cancelled')
        }
        const request = fetchImpl(definition.url!, {
          method: 'GET',
          headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
          redirect: 'error',
          signal: controller.signal,
        })
        controller.signal.addEventListener('abort', () => {
          void request.then((lateResponse) => lateResponse.body?.cancel()).catch(() => undefined)
        }, { once: true })
        const abortFailure = new Promise<never>((_resolve, reject) => {
          controller!.signal.addEventListener('abort', () => {
            reject(new SafeExportError('Service request timed out or was cancelled'))
          }, { once: true })
        })
        const response = await Promise.race([request, abortFailure])
        if (!response.ok) {
          try { await response.body?.cancel() } catch { /* ignore */ }
          throw new SafeExportError(`Service returned HTTP ${response.status}`)
        }
        if (!response.body) throw new SafeExportError('Service returned an empty response')
        const contentType = response.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase()
        if (contentType !== 'application/json' && !contentType?.endsWith('+json')) {
          try { await response.body.cancel() } catch { /* ignore */ }
          throw new SafeExportError('Service returned a non-JSON response')
        }
        const contentLength = Number(response.headers.get('Content-Length'))
        if (Number.isFinite(contentLength) && contentLength > 0 && contentLength > maxResponseBytes) {
          try { await response.body.cancel() } catch { /* ignore */ }
          throw new SafeExportError('Service response exceeded its size limit')
        }

        const descriptor = openSync(temporaryPath, 'wx', 0o600)
        const reader = response.body.getReader()
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            try {
              reserve(value.byteLength)
            } catch (error) {
              await reader.cancel().catch(() => undefined)
              throw error
            }
            writeSync(descriptor, value)
          }
        } finally {
          closeSync(descriptor)
        }
        contents = readFileSync(temporaryPath)
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(contents.toString('utf8'))
      } catch {
        throw new SafeExportError('Service returned invalid JSON')
      }
      const envelope = exportEnvelopeSchema.safeParse(parsed)
      if (!envelope.success || envelope.data.service !== definition.service) {
        throw new SafeExportError('Service returned an invalid export envelope')
      }
      if (!ownsLease(job.id, leaseId)) throw new SafeExportError('Export job was cancelled')

      renameSync(temporaryPath, finalPath)
      const sha256 = createHash('sha256').update(contents).digest('hex')
      if (!finishServiceAttempt(job.id, leaseId, definition.service, started.attemptId, now().getTime(), {
        status: 'succeeded', bytes: attemptBytes, sha256, snapshotPath: finalPath,
      })) {
        removeFile(finalPath)
        storage.release(attemptBytes)
      }
    } catch (error) {
      removeFile(temporaryPath)
      removeFile(finalPath)
      storage.release(attemptBytes)
      releaseBudget()
      const message = sanitizedError(error, definition.service, controller?.signal.aborted ?? false)
      finishServiceAttempt(job.id, leaseId, definition.service, started.attemptId, now().getTime(), {
        status: 'failed', error: message,
      })
    } finally {
      if (timeout) clearTimeout(timeout)
      if (controller) {
        const controllers = activeRequests.get(job.id)
        controllers?.delete(controller)
        if (controllers?.size === 0) activeRequests.delete(job.id)
      }
      if (externalAbort) options.signal?.removeEventListener('abort', externalAbort)
    }
  }

  try {
    const pending = sqlite.prepare(`
      SELECT service FROM export_job_services
      WHERE job_id = ? AND status != 'succeeded'
      ORDER BY rowid
    `).all(job.id) as Array<{ service: ExportServiceName }>
    const definitions = pending
      .map(({ service }) => services.find((definition) => definition.service === service))
      .filter((definition): definition is ExportServiceDefinition => definition !== undefined)
    let next = 0
    const runners = Array.from({ length: Math.min(maxConcurrency, definitions.length) }, async () => {
      while (next < definitions.length) {
        const definition = definitions[next++]!
        await attemptService(definition)
        if (!ownsLease(job.id, leaseId)) return
      }
    })
    await Promise.all(runners)

    if (!ownsLease(job.id, leaseId)) return 1
    const rows = sqlite.prepare(`
      SELECT * FROM export_job_services WHERE job_id = ? ORDER BY rowid
    `).all(job.id) as ExportServiceRow[]
    const succeeded = rows.filter((row) => row.status === 'succeeded').length
    const completedAt = now()
    const finalStatus = succeeded === rows.length ? 'completed' : succeeded > 0 ? 'partial' : 'failed'
    const expiresAt = completedAt.getTime() + artifactTtlMs
    const oldArchivePath = job.archive_path
    const oldArchiveBytes = job.archive_bytes
    let archivePath: string | null = oldArchivePath
    let archiveBytes: number | null = oldArchiveBytes
    let archiveError: string | null = null

    if (succeeded > 0) {
      const retained = sqlite.prepare(`
        SELECT COALESCE(SUM(archive_bytes), 0) AS bytes FROM export_jobs
        WHERE owner_user_id = ? AND id != ? AND status != 'expired'
      `).get(job.owner_user_id, job.id) as { bytes: number }
      const maximumArchiveBytes = aggregateBytes + 1024 * 1024
      const temporaryArchive = join(directory, `export-${leaseId}.zip.tmp`)
      const candidateArchive = join(directory, `export-${leaseId}.zip`)
      try {
        if (retained.bytes + maximumArchiveBytes > maxUserRetainedArtifactBytes) {
          throw new SafeExportError('Per-user retained export artifact limit reached')
        }
        storage.check(maximumArchiveBytes)
        renewLease(job.id, leaseId, now().getTime() + leaseMs)
        removeFile(temporaryArchive)
        const manifest = {
          version: '1',
          jobId: job.id,
          status: finalStatus,
          createdAt: new Date(job.created_at).toISOString(),
          startedAt: new Date(job.started_at ?? claimedAt).toISOString(),
          completedAt: completedAt.toISOString(),
          services: rows.map((row) => ({
            service: row.service,
            status: row.status,
            attempts: row.attempts,
            file: row.status === 'succeeded' ? `services/${row.service}.json` : null,
            errorFile: row.status === 'failed' ? `errors/${row.service}.json` : null,
            bytes: row.bytes,
            sha256: row.sha256,
            startedAt: row.started_at == null ? null : new Date(row.started_at).toISOString(),
            completedAt: row.completed_at == null ? null : new Date(row.completed_at).toISOString(),
            error: row.last_error,
          })),
        }
        await writeZip(temporaryArchive, manifest, rows, directory, completedAt, (bytes) => storage.reserve(bytes))
        renameSync(temporaryArchive, candidateArchive)
        chmodSync(candidateArchive, 0o600)
        archivePath = candidateArchive
        archiveBytes = statSync(candidateArchive).size
      } catch (error) {
        const temporaryBytes = (() => {
          try { return statSync(temporaryArchive).size } catch { return 0 }
        })()
        removeFile(temporaryArchive)
        removeFile(candidateArchive)
        storage.release(temporaryBytes)
        archiveError = sanitizedError(error, 'schlussel', false)
      }
    }

    const publishedStatus = archiveError
      ? oldArchivePath ? 'partial' : 'failed'
      : finalStatus
    const finalized = sqlite.prepare(`
      UPDATE export_jobs
      SET status = ?, completed_at = ?, expires_at = ?, archive_path = ?, archive_bytes = ?, last_error = ?,
          lease_id = NULL, lease_until = NULL
      WHERE id = ? AND status = 'running' AND lease_id = ?
    `).run(publishedStatus, completedAt.getTime(), expiresAt, archivePath, archiveBytes, archiveError, job.id, leaseId)
    if (finalized.changes === 0) {
      if (archivePath !== oldArchivePath) removeFile(archivePath)
    } else if (archivePath !== oldArchivePath) {
      removeFile(oldArchivePath)
    }
    return 1
  } finally {
    clearInterval(heartbeat)
    const current = sqlite.prepare('SELECT status FROM export_jobs WHERE id = ?').get(job.id) as { status: string } | undefined
    if (current?.status === 'cancelled') {
      rmSync(directory, { recursive: true, force: true })
    }
  }
}

export function cleanupExpiredExports(options: CleanupExportOptions = {}): number {
  const nowMs = (options.now ?? (() => new Date()))().getTime()
  const exportDir = resolve(options.exportDir ?? defaultConfig.exportDir)
  ensurePrivateDirectory(exportDir)
  const expired = sqlite.transaction(() => {
    const rows = sqlite.prepare(`
      SELECT id FROM export_jobs
      WHERE expires_at IS NOT NULL AND expires_at <= ? AND status != 'expired'
    `).all(nowMs) as Array<{ id: string }>
    const expire = sqlite.prepare(`
      UPDATE export_jobs
      SET status = 'expired', archive_path = NULL, archive_bytes = NULL,
          lease_id = NULL, lease_until = NULL
      WHERE id = ? AND expires_at IS NOT NULL AND expires_at <= ? AND status != 'expired'
    `)
    for (const { id } of rows) expire.run(id, nowMs)
    return rows
  }).immediate()

  // Deletion follows the durable transition. Retry can no longer requeue a row
  // once cleanup has claimed it, and failed filesystem cleanup is retried later.
  const expiredDirectories = sqlite.prepare(`
    SELECT id FROM export_jobs WHERE status = 'expired'
  `).all() as Array<{ id: string }>
  for (const { id } of expiredDirectories) {
    rmSync(safeJobDirectory(exportDir, id), { recursive: true, force: true })
  }

  const known = new Set((sqlite.prepare('SELECT id FROM export_jobs').all() as Array<{ id: string }>).map(({ id }) => id))
  for (const entry of readdirSync(exportDir, { withFileTypes: true })) {
    if (entry.isDirectory() && !known.has(entry.name)) {
      rmSync(join(exportDir, entry.name), { recursive: true, force: true })
    }
  }
  return expired.length
}

export interface StartExportWorkerOptions extends DispatchExportJobOptions {
  intervalMs?: number
  stopTimeoutMs?: number
  onError?: () => void
}

export function startExportWorker(options: StartExportWorkerOptions = {}) {
  const intervalMs = options.intervalMs ?? defaultConfig.dispatchIntervalMs
  const stopTimeoutMs = options.stopTimeoutMs ?? defaultConfig.workerStopTimeoutMs
  let active: Promise<void> | null = null
  let stopped = false
  const controller = new AbortController()

  const run = () => {
    if (stopped || active) return
    active = Promise.resolve()
      .then(() => { cleanupExpiredExports(options) })
      .then(() => dispatchExportJobBatch({ ...options, signal: controller.signal }))
      .then(() => undefined)
      .catch(() => options.onError?.())
      .finally(() => { active = null })
  }
  const timer = setInterval(run, intervalMs)
  timer.unref()
  run()

  return {
    async stop() {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      controller.abort()
      if (!active) return
      await Promise.race([
        active,
        new Promise<void>((resolvePromise) => setTimeout(resolvePromise, stopTimeoutMs)),
      ])
    },
  }
}

export function isSafeArchivePath(exportDir: string, archivePath: string): boolean {
  if (!isAbsolute(archivePath)) return false
  const root = resolve(exportDir)
  const path = resolve(archivePath)
  const relation = relative(root, path)
  return relation !== '' && !relation.startsWith('..')
}
