import { and, asc, eq, isNull, lte, or } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { db } from '../db/index.js'
import { deletionJobs, deletionJobTargets, type DeletionJobTarget } from '../db/schema.js'
import { loadDeletionConfig, type DeletionConfig } from '../config.js'
import { signDeletionToken } from '../utils/jwt.js'

// The full universe of services Schlussel could ever hold a deletion target
// for - matches the deletion_job_targets.service DB enum. Not every one of
// these is necessarily enabled in a given deployment; see
// ENABLED_DELETION_SERVICES below for the ones actually dispatched to.
export const DELETION_SERVICES = ['kuvert', 'tafel', 'zettel', 'glocke', 'schrank', 'herold'] as const
export type DeletionService = typeof DELETION_SERVICES[number]
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export function enabledDeletionServices(
  config: Pick<DeletionConfig, 'serviceUrls'>,
): DeletionService[] {
  return DELETION_SERVICES.filter((service) => config.serviceUrls[service] !== undefined)
}

// A disabled service never gets a deletion target enqueued at all - it's
// not attempted and reported as failed, it simply never existed for this
// deployment. See ADR-style note in PLATFORM-OPS-PLAN.md item 4.
export const ENABLED_DELETION_SERVICES = enabledDeletionServices(loadDeletionConfig())

export function enqueueDeletionJob(
  tx: Transaction,
  userId: string,
  initiatedBy: 'self' | 'admin',
  now = Date.now(),
  jobId = randomUUID(),
  services: readonly DeletionService[] = ENABLED_DELETION_SERVICES,
): string {
  tx.insert(deletionJobs).values({ id: jobId, userId, initiatedBy, createdAt: now }).run()
  if (services.length > 0) {
    tx.insert(deletionJobTargets).values(services.map((service) => ({
      jobId, service, nextAttemptAt: now,
    }))).run()
  } else {
    // No optional service is enabled in this deployment - there is nothing
    // for the dispatch worker to ever settle, so the job is complete as soon
    // as it's created rather than sitting at 'pending' forever.
    tx.update(deletionJobs).set({ status: 'completed', startedAt: now, completedAt: now })
      .where(eq(deletionJobs.id, jobId)).run()
  }
  return jobId
}

function eligibleAt(now: number) {
  return or(
    and(eq(deletionJobTargets.status, 'pending'), or(
      isNull(deletionJobTargets.nextAttemptAt), lte(deletionJobTargets.nextAttemptAt, now),
    )),
    and(eq(deletionJobTargets.status, 'inflight'), or(
      isNull(deletionJobTargets.leaseUntil), lte(deletionJobTargets.leaseUntil, now),
    )),
  )
}

function claim(now: number, leaseId: string, leaseMs: number) {
  return db.transaction((tx) => {
    const target = tx.select().from(deletionJobTargets).where(eligibleAt(now))
      .orderBy(asc(deletionJobTargets.nextAttemptAt), asc(deletionJobTargets.jobId), asc(deletionJobTargets.service))
      .limit(1).get()
    if (!target) return null
    const job = tx.select().from(deletionJobs).where(eq(deletionJobs.id, target.jobId)).get()
    if (!job) return null
    tx.update(deletionJobTargets).set({ status: 'inflight', leaseId, leaseUntil: now + leaseMs })
      .where(and(eq(deletionJobTargets.jobId, target.jobId), eq(deletionJobTargets.service, target.service))).run()
    tx.update(deletionJobs).set({ status: 'running', startedAt: job.startedAt ?? now })
      .where(eq(deletionJobs.id, job.id)).run()
    return { target, job }
  })
}

function updateJob(tx: Transaction, jobId: string, now: number) {
  const targets = tx.select().from(deletionJobTargets).where(eq(deletionJobTargets.jobId, jobId)).all()
  if (targets.every((target) => target.status === 'delivered')) {
    tx.update(deletionJobs).set({ status: 'completed', completedAt: now }).where(eq(deletionJobs.id, jobId)).run()
  } else if (targets.every((target) => target.status === 'delivered' || target.status === 'permanent')) {
    tx.update(deletionJobs).set({ status: 'failed', completedAt: now }).where(eq(deletionJobs.id, jobId)).run()
  }
}

function settle(
  row: DeletionJobTarget,
  leaseId: string,
  now: number,
  values: Partial<typeof deletionJobTargets.$inferInsert>,
) {
  db.transaction((tx) => {
    tx.update(deletionJobTargets).set({ ...values, leaseId: null, leaseUntil: null }).where(and(
      eq(deletionJobTargets.jobId, row.jobId), eq(deletionJobTargets.service, row.service),
      eq(deletionJobTargets.status, 'inflight'), eq(deletionJobTargets.leaseId, leaseId),
    )).run()
    updateJob(tx, row.jobId, now)
  })
}

function retryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

function delay(attempt: number, base: number, maximum: number, random: () => number): number {
  return Math.floor(random() * Math.min(maximum, base * 2 ** Math.max(0, attempt - 1)))
}

export interface DispatchDeletionOptions extends Omit<DeletionConfig, 'dispatchIntervalMs' | 'workerStopTimeoutMs'> {
  fetch?: typeof fetch
  now?: () => Date
  random?: () => number
  createId?: () => string
  signal?: AbortSignal
}

export async function dispatchDeletionTarget(options: DispatchDeletionOptions): Promise<number> {
  const now = options.now ?? (() => new Date())
  const random = options.random ?? Math.random
  const leaseId = (options.createId ?? randomUUID)()
  const claimed = claim(now().getTime(), leaseId, options.leaseMs)
  if (!claimed) return 0
  const attempts = claimed.target.attempts + 1
  const attemptedAt = now()
  const targetUrl = options.serviceUrls[claimed.target.service]
  if (targetUrl === undefined) {
    // Invariant violation, not a normal runtime failure: enqueueDeletionJob
    // only ever inserts a target for a service with a configured URL. Fail
    // permanently rather than retry forever against a URL that will never
    // appear.
    settle(claimed.target, leaseId, now().getTime(), {
      status: 'permanent', attempts, nextAttemptAt: null,
      lastError: `${claimed.target.service} has no configured deletion URL`,
    })
    return 1
  }
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (options.signal?.aborted) abort()
  else options.signal?.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(abort, options.fetchTimeoutMs)
  timeout.unref()
  let response: Response | undefined
  try {
    const token = await signDeletionToken(claimed.job.userId, claimed.target.service, claimed.job.id, attemptedAt)
    response = await (options.fetch ?? fetch)(targetUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: claimed.job.id, userId: claimed.job.userId }),
      signal: controller.signal,
    })
    const completedAt = now().getTime()
    if (response.ok) {
      settle(claimed.target, leaseId, completedAt, {
        status: 'delivered', attempts, nextAttemptAt: null, deliveredAt: completedAt, lastError: null,
      })
    } else if (!retryable(response.status) || attempts >= options.maxAttempts) {
      settle(claimed.target, leaseId, completedAt, {
        status: 'permanent', attempts, nextAttemptAt: null, lastError: `HTTP ${response.status}`,
      })
    } else {
      settle(claimed.target, leaseId, completedAt, {
        status: 'pending', attempts,
        nextAttemptAt: completedAt + delay(attempts, options.baseDelayMs, options.maxDelayMs, random),
        lastError: `HTTP ${response.status}`,
      })
    }
  } catch (error) {
    const completedAt = now().getTime()
    const terminal = attempts >= options.maxAttempts
    settle(claimed.target, leaseId, completedAt, {
      status: terminal ? 'permanent' : 'pending', attempts,
      nextAttemptAt: terminal ? null : completedAt + delay(attempts, options.baseDelayMs, options.maxDelayMs, random),
      lastError: error instanceof Error && error.name === 'AbortError' ? 'Request timed out' : 'Request failed',
    })
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abort)
    if (response?.body) void response.body.cancel().catch(() => undefined)
  }
  return 1
}

export function startDeletionWorker(config: DeletionConfig & { onError?: () => void }) {
  const controller = new AbortController()
  let running: Promise<void> | null = null
  let stopped = false
  const run = () => {
    if (stopped || running) return
    running = (async () => {
      try {
        while (!stopped && await dispatchDeletionTarget({ ...config, signal: controller.signal })) {
          // Drain all currently eligible targets before sleeping.
        }
      } catch { config.onError?.() } finally { running = null }
    })()
  }
  const timer = setInterval(run, config.dispatchIntervalMs)
  timer.unref()
  run()
  return {
    stop: async () => {
      stopped = true
      clearInterval(timer)
      controller.abort()
      await Promise.race([
        running ?? Promise.resolve(),
        new Promise<void>((resolve) => setTimeout(resolve, config.workerStopTimeoutMs)),
      ])
    },
  }
}
