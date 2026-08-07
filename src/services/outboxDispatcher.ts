import {
  calculateBackoffDelay,
  classifyNotificationResponse,
  notificationEventEnvelopeSchema,
  parseRetryAfter,
  signNotificationRequest,
} from '@zudar107/schloss-server-kit'
import { and, asc, eq, isNull, lte, or } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { db } from '../db/index.js'
import { notificationOutbox, type NotificationOutbox } from '../db/schema.js'

const EVENT_PATH = '/internal/v1/events'
const EVENT_SOURCE = 'schlussel'
const DEFAULT_GLOCKE_BASE_URL = 'http://glocke-backend:3004'
const DEFAULT_LEASE_MS = 30_000
const DEFAULT_FETCH_TIMEOUT_MS = 10_000
const DEFAULT_STOP_TIMEOUT_MS = 5_000
const DEFAULT_MAX_ATTEMPTS = 8
const DEFAULT_BASE_DELAY_MS = 1_000
const DEFAULT_MAX_DELAY_MS = 15 * 60_000
const MAX_TIMER_VALUE = 2_147_483_647
const SAFE_ERROR_NAMES = new Set(['AbortError', 'Error', 'TimeoutError', 'TypeError'])

export interface DispatchOutboxOptions {
  fetch?: typeof fetch
  now?: () => Date
  random?: () => number
  createId?: () => string
  glockeBaseUrl?: string
  keyId?: string
  secret?: string
  leaseMs?: number
  fetchTimeoutMs?: number
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  signal?: AbortSignal
}

function eligibleAt(nowMs: number) {
  return or(
    and(
      eq(notificationOutbox.state, 'pending'),
      or(isNull(notificationOutbox.nextAttemptAt), lte(notificationOutbox.nextAttemptAt, nowMs)),
    ),
    and(
      eq(notificationOutbox.state, 'inflight'),
      or(isNull(notificationOutbox.leaseUntil), lte(notificationOutbox.leaseUntil, nowMs)),
    ),
  )
}

function claimNext(nowMs: number, leaseId: string, leaseMs: number) {
  return db.transaction((tx) => {
    const row = tx.select()
      .from(notificationOutbox)
      .where(eligibleAt(nowMs))
      .orderBy(asc(notificationOutbox.createdAt), asc(notificationOutbox.id))
      .limit(1)
      .get()

    if (row) {
      tx.update(notificationOutbox).set({
        state: 'inflight',
        leaseId,
        leaseUntil: nowMs + leaseMs,
      }).where(eq(notificationOutbox.id, row.id)).run()
    }

    return row
  })
}

function safeError(error: unknown, aborted: boolean): string {
  if (aborted) return 'Glocke request timed out or was cancelled'
  const name = error instanceof Error && SAFE_ERROR_NAMES.has(error.name) ? error.name : null
  return name ? `Glocke request failed (${name})` : 'Glocke request failed'
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_VALUE) {
    throw new Error(`${name} must be a positive integer no greater than ${MAX_TIMER_VALUE}`)
  }
  return value
}

function releaseResponse(response: Response | undefined) {
  try {
    if (response?.body) void response.body.cancel().catch(() => undefined)
  } catch {
    // A body owned by an unusual injected fetch must not block state updates.
  }
}

function updateClaim(
  row: NotificationOutbox,
  leaseId: string,
  values: Partial<typeof notificationOutbox.$inferInsert>,
) {
  db.update(notificationOutbox).set(values).where(and(
    eq(notificationOutbox.id, row.id),
    eq(notificationOutbox.state, 'inflight'),
    eq(notificationOutbox.leaseId, leaseId),
  )).run()
}

export async function dispatchOutboxBatch(options: DispatchOutboxOptions = {}): Promise<number> {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const now = options.now ?? (() => new Date())
  const random = options.random ?? Math.random
  const createId = options.createId ?? randomUUID
  const keyId = options.keyId ?? process.env['SCHLUSSEL_TO_GLOCKE_HMAC_KEY_ID']
  const secret = options.secret ?? process.env['SCHLUSSEL_TO_GLOCKE_HMAC_SECRET']
  if (!keyId || !secret) throw new Error('Schlussel-to-Glocke HMAC credentials are not configured')

  if (Buffer.byteLength(secret) < 32) throw new Error('Schlussel-to-Glocke HMAC secret must be at least 32 bytes')
  const leaseMs = positiveInteger('leaseMs', options.leaseMs ?? DEFAULT_LEASE_MS)
  const fetchTimeoutMs = positiveInteger('fetchTimeoutMs', options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS)
  const maxAttempts = positiveInteger('maxAttempts', options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
  const baseDelayMs = positiveInteger('baseDelayMs', options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS)
  const maxDelayMs = positiveInteger('maxDelayMs', options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS)
  if (fetchTimeoutMs >= leaseMs) throw new Error('fetchTimeoutMs must be shorter than leaseMs')
  const claimedAt = now().getTime()
  const leaseId = createId()
  const row = claimNext(claimedAt, leaseId, leaseMs)
  const endpoint = `${(options.glockeBaseUrl ?? process.env['GLOCKE_BASE_URL'] ?? DEFAULT_GLOCKE_BASE_URL).replace(/\/$/, '')}${EVENT_PATH}`
  if (!row) return 0

  {
    const attemptedAt = now().getTime()
    const attempts = row.attempts + 1

    let body: string
    try {
      const envelope = notificationEventEnvelopeSchema.parse({
        version: '1',
        id: row.id,
        type: row.eventType,
        source: EVENT_SOURCE,
        occurredAt: new Date(row.createdAt).toISOString(),
        correlationId: row.correlationId,
        payload: JSON.parse(row.payload) as unknown,
      })
      body = JSON.stringify(envelope)
    } catch {
      updateClaim(row, leaseId, {
        state: 'permanent',
        attempts,
        nextAttemptAt: null,
        leaseId: null,
        leaseUntil: null,
        lastError: 'Invalid notification outbox event',
      })
      return 1
    }

    const timestamp = Math.floor(attemptedAt / 1_000)
    const signature = signNotificationRequest({
      secret,
      keyId,
      source: EVENT_SOURCE,
      timestamp,
      method: 'POST',
      path: EVENT_PATH,
      rawBody: body,
    })

    const controller = new AbortController()
    const cancel = () => controller.abort()
    if (options.signal?.aborted) cancel()
    else options.signal?.addEventListener('abort', cancel, { once: true })
    const timeout = setTimeout(cancel, fetchTimeoutMs)
    timeout.unref()
    let response: Response | undefined

    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hof-Key-Id': keyId,
          'X-Hof-Service': EVENT_SOURCE,
          'X-Hof-Timestamp': timestamp.toString(),
          'X-Hof-Signature': signature,
        },
        body,
        signal: controller.signal,
      })
      const completedAt = now().getTime()
      const classification = classifyNotificationResponse(response.status)

      if (classification === 'success') {
        updateClaim(row, leaseId, {
          state: 'delivered',
          attempts,
          nextAttemptAt: null,
          leaseId: null,
          leaseUntil: null,
          deliveredAt: completedAt,
          lastError: null,
        })
        return 1
      }

      if (classification === 'permanent' || attempts >= maxAttempts) {
        updateClaim(row, leaseId, {
          state: 'permanent',
          attempts,
          nextAttemptAt: null,
          leaseId: null,
          leaseUntil: null,
          lastError: `Glocke returned HTTP ${response.status}`,
        })
        return 1
      }

      const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'), { now: () => completedAt })
      const delayMs = retryAfterMs ?? calculateBackoffDelay({
        attempt: row.attempts,
        baseDelayMs,
        maxDelayMs,
        random,
      })
      updateClaim(row, leaseId, {
        state: 'pending',
        attempts,
        nextAttemptAt: completedAt + Math.min(delayMs, Number.MAX_SAFE_INTEGER - completedAt),
        leaseId: null,
        leaseUntil: null,
        lastError: `Glocke returned HTTP ${response.status}`,
      })
    } catch (error) {
      const failedAt = now().getTime()
      if (attempts >= maxAttempts) {
        updateClaim(row, leaseId, {
          state: 'permanent',
          attempts,
          nextAttemptAt: null,
          leaseId: null,
          leaseUntil: null,
          lastError: safeError(error, controller.signal.aborted),
        })
        return 1
      }

      const delayMs = calculateBackoffDelay({
        attempt: row.attempts,
        baseDelayMs,
        maxDelayMs,
        random,
      })
      updateClaim(row, leaseId, {
        state: 'pending',
        attempts,
        nextAttemptAt: failedAt + delayMs,
        leaseId: null,
        leaseUntil: null,
        lastError: safeError(error, controller.signal.aborted),
      })
    } finally {
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', cancel)
      releaseResponse(response)
    }
  }

  return 1
}

export interface StartOutboxDispatcherOptions extends DispatchOutboxOptions {
  intervalMs?: number
  stopTimeoutMs?: number
  onError?: () => void
}

export function startOutboxDispatcher(options: StartOutboxDispatcherOptions = {}) {
  const intervalMs = options.intervalMs ?? 1_000
  const stopTimeoutMs = positiveInteger('stopTimeoutMs', options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS)
  positiveInteger('intervalMs', intervalMs)
  let active: Promise<void> | null = null
  let stopped = false
  const stopController = new AbortController()

  const run = () => {
    if (stopped || active) return
    active = dispatchOutboxBatch({ ...options, signal: stopController.signal })
      .then(() => undefined)
      .catch(() => options.onError?.())
      .finally(() => { active = null })
  }

  const timer = setInterval(run, intervalMs)
  timer.unref()
  run()

  return {
    async stop(): Promise<void> {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      stopController.abort()
      const worker = active
      if (!worker) return
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, stopTimeoutMs)
        void worker.finally(() => {
          clearTimeout(timeout)
          resolve()
        })
      })
    },
  }
}
