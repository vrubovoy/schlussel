import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { notificationEventEnvelopeSchema, verifyNotificationRequest } from '@zudar107/schloss-server-kit'
import { z } from 'zod'

const testId = randomUUID().slice(0, 8)
const DB_PATH = join(tmpdir(), `schlussel-test-outbox-dispatcher-${testId}.db`)
const MIGRATIONS_DIR = fileURLToPath(new URL('../db/migrations', import.meta.url))
const EVENT_ID = '7ba5b126-9258-4bd1-a019-8bc3220347bf'
const USER_ID = 'user-alice-1'
const EVENT_TYPE = 'schlussel.security.password_changed.v1'
const KEY_ID = 'schlussel-test-key'
const HMAC_SECRET = 'test-only-schlussel-to-glocke-secret'

process.env['DATABASE_PATH'] = DB_PATH

interface DispatchOptions {
  fetch: typeof fetch
  now: () => Date
  glockeBaseUrl: string
  keyId: string
  secret: string
  random: () => number
  leaseMs?: number
  fetchTimeoutMs?: number
}

interface RetryRow {
  state: 'pending' | 'inflight' | 'delivered' | 'permanent'
  attempts: number
  next_attempt_at: number | null
  lease_id: string | null
  lease_until: number | null
  delivered_at: number | null
  last_error: string | null
}

let sqlite: import('better-sqlite3').Database
let dispatchOutboxBatch: (options: DispatchOptions) => Promise<unknown>
let startOutboxDispatcher: (options: DispatchOptions & {
  intervalMs: number
  stopTimeoutMs: number
}) => { stop: () => Promise<void> }

beforeAll(async () => {
  const [dispatcherModule, dbModule, migratorModule] = await Promise.all([
    import('../services/outboxDispatcher.js'),
    import('../db/index.js'),
    import('drizzle-orm/better-sqlite3/migrator'),
  ])

  sqlite = dbModule.sqlite
  dispatchOutboxBatch = dispatcherModule.dispatchOutboxBatch
  startOutboxDispatcher = dispatcherModule.startOutboxDispatcher
  migratorModule.migrate(dbModule.db, { migrationsFolder: MIGRATIONS_DIR })
})

beforeEach(() => {
  sqlite.exec('DELETE FROM notification_outbox')
})

afterAll(() => {
  try { sqlite?.close() } catch { /* ignore */ }
  try { rmSync(DB_PATH) } catch { /* ignore */ }
})

function row(): RetryRow {
  return sqlite.prepare(
    'SELECT state, attempts, next_attempt_at, lease_id, lease_until, delivered_at, last_error FROM notification_outbox WHERE id = ?',
  ).get(EVENT_ID) as RetryRow
}

function insertEvent(createdAt: Date, state: 'pending' | 'inflight' = 'pending', leaseUntil: number | null = null) {
  sqlite.prepare(`
    INSERT INTO notification_outbox
      (id, event_type, user_id, payload, correlation_id, state, created_at, attempts, next_attempt_at, lease_id, lease_until, delivered_at, last_error)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, NULL)
  `).run(
    EVENT_ID,
    EVENT_TYPE,
    USER_ID,
    JSON.stringify({ recipientId: USER_ID }),
    EVENT_ID,
    state,
    createdAt.getTime(),
    createdAt.getTime(),
    state === 'inflight' ? 'expired-lease' : null,
    leaseUntil,
  )
}

function options(now: () => Date, fetchMock: typeof fetch): DispatchOptions {
  return {
    fetch: fetchMock,
    now,
    glockeBaseUrl: 'http://glocke.test:4010',
    keyId: KEY_ID,
    secret: HMAC_SECRET,
    random: () => 0.5,
  }
}

function requestBody(call: unknown[]): Record<string, unknown> {
  const init = call[1] as RequestInit
  return JSON.parse(init.body as string) as Record<string, unknown>
}

describe('dispatchOutboxBatch', () => {
  it('retries a response-lost delivery with the same event identity and persists retry state', async () => {
    const createdAt = new Date('2026-08-07T10:00:00.000Z')
    insertEvent(createdAt)

    let now = createdAt
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('response lost after Glocke accepted the event'))
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
    const dispatchOptions = options(() => now, fetchMock)

    await dispatchOutboxBatch(dispatchOptions)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const retry = row()
    expect(retry.attempts).toBe(1)
    expect(retry.delivered_at).toBeNull()
    expect(retry.last_error).toBe('Glocke request failed (Error)')
    expect(retry.last_error).not.toContain('response lost')
    expect(retry.next_attempt_at).toBeGreaterThan(now.getTime())

    await dispatchOutboxBatch(dispatchOptions)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    now = new Date(retry.next_attempt_at!)
    await dispatchOutboxBatch(dispatchOptions)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const delivered = row()
    expect(delivered.attempts).toBe(2)
    expect(delivered.delivered_at).toBe(now.getTime())
    expect(delivered.last_error).toBeNull()

    const firstCall = fetchMock.mock.calls[0]!
    const secondCall = fetchMock.mock.calls[1]!
    expect(firstCall[0]).toBe('http://glocke.test:4010/internal/v1/events')
    expect(secondCall[0]).toBe(firstCall[0])
    expect(requestBody(firstCall)).toEqual(requestBody(secondCall))
    expect(requestBody(firstCall)).toEqual({
      version: '1',
      id: EVENT_ID,
      type: EVENT_TYPE,
      source: 'schlussel',
      occurredAt: createdAt.toISOString(),
      correlationId: EVENT_ID,
      payload: { recipientId: USER_ID },
    })

    const firstHeaders = new Headers((firstCall[1] as RequestInit).headers)
    const secondHeaders = new Headers((secondCall[1] as RequestInit).headers)
    expect(firstHeaders.get('X-Hof-Key-Id')).toBe(KEY_ID)
    expect(firstHeaders.get('X-Hof-Service')).toBe('schlussel')
    expect(secondHeaders.get('X-Hof-Key-Id')).toBe(KEY_ID)
    expect(verifyNotificationRequest({
      secret: HMAC_SECRET,
      keyId: firstHeaders.get('X-Hof-Key-Id')!,
      source: firstHeaders.get('X-Hof-Service')!,
      timestamp: Number(firstHeaders.get('X-Hof-Timestamp')),
      method: 'POST',
      path: '/internal/v1/events',
      rawBody: (firstCall[1] as RequestInit).body as string,
      signature: firstHeaders.get('X-Hof-Signature')!,
      expectedKeyId: KEY_ID,
      expectedSource: 'schlussel',
      maxSkewSeconds: 0,
      now: () => createdAt.getTime(),
    })).toBe(true)

    const glockePasswordChangedEventSchema = notificationEventEnvelopeSchema.extend({
      source: z.literal('schlussel'),
      type: z.literal(EVENT_TYPE),
      payload: z.object({ recipientId: z.string().min(1) }).strict(),
    })
    expect(glockePasswordChangedEventSchema.parse(requestBody(firstCall)).payload).toEqual({
      recipientId: USER_ID,
    })
  })

  it('honors Retry-After for a retryable response and releases the lease', async () => {
    const now = new Date('2026-08-07T10:00:00.123Z')
    insertEvent(now)
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {
      status: 429,
      headers: { 'Retry-After': '12' },
    }))

    await dispatchOutboxBatch(options(() => now, fetchMock))

    expect(row()).toEqual({
      state: 'pending',
      attempts: 1,
      next_attempt_at: now.getTime() + 12_000,
      lease_id: null,
      lease_until: null,
      delivered_at: null,
      last_error: 'Glocke returned HTTP 429',
    })
  })

  it('moves a non-retryable response to the permanent terminal state', async () => {
    const now = new Date('2026-08-07T10:00:00.123Z')
    insertEvent(now)
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 400 }))

    await dispatchOutboxBatch(options(() => now, fetchMock))

    expect(row()).toMatchObject({
      state: 'permanent',
      attempts: 1,
      next_attempt_at: null,
      lease_id: null,
      lease_until: null,
      delivered_at: null,
      last_error: 'Glocke returned HTTP 400',
    })
  })

  it('recovers and delivers an inflight row whose worker lease expired', async () => {
    const now = new Date('2026-08-07T10:00:30.000Z')
    insertEvent(new Date('2026-08-07T10:00:00.000Z'), 'inflight', now.getTime() - 1)
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 }))

    await dispatchOutboxBatch(options(() => now, fetchMock))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(row()).toMatchObject({
      state: 'delivered',
      attempts: 1,
      next_attempt_at: null,
      lease_id: null,
      lease_until: null,
      delivered_at: now.getTime(),
      last_error: null,
    })
  })

  it('claims only one row so queued work cannot expire under a shared lease', async () => {
    const now = new Date('2026-08-07T10:00:00.000Z')
    insertEvent(now)
    sqlite.prepare(`
      INSERT INTO notification_outbox
        (id, event_type, user_id, payload, correlation_id, created_at, next_attempt_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'd14b8de2-a377-480e-8d2f-acb50f83a306',
      EVENT_TYPE,
      'user-bob-1',
      JSON.stringify({ recipientId: 'user-bob-1' }),
      'd14b8de2-a377-480e-8d2f-acb50f83a306',
      now.getTime() + 1,
      now.getTime(),
    )
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 }))

    expect(await dispatchOutboxBatch(options(() => now, fetchMock))).toBe(1)

    const states = sqlite.prepare('SELECT state, lease_id FROM notification_outbox ORDER BY created_at').all()
    expect(states).toEqual([
      { state: 'delivered', lease_id: null },
      { state: 'pending', lease_id: null },
    ])
  })

  it('cancels an unread response body after classifying the response', async () => {
    const now = new Date('2026-08-07T10:00:00.000Z')
    insertEvent(now)
    const cancel = vi.fn()
    const body = new ReadableStream({ cancel })
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 202 }))

    await dispatchOutboxBatch(options(() => now, fetchMock))
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
  })

  it('aborts a delivery before its lease expires and stores only sanitized diagnostics', async () => {
    const now = new Date('2026-08-07T10:00:00.000Z')
    insertEvent(now)
    const fetchMock = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error(`secret=${HMAC_SECRET}; payload=${USER_ID}`)))
    }))
    const dispatchOptions = {
      ...options(() => now, fetchMock),
      leaseMs: 100,
      fetchTimeoutMs: 10,
    }

    await dispatchOutboxBatch(dispatchOptions)

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(row()).toMatchObject({
      state: 'pending',
      attempts: 1,
      lease_id: null,
      lease_until: null,
      last_error: 'Glocke request timed out or was cancelled',
    })
    expect(row().last_error).not.toContain(HMAC_SECRET)
    expect(row().last_error).not.toContain(USER_ID)
  })

  it('bounds dispatcher stop even when an injected fetch ignores cancellation', async () => {
    const now = new Date('2026-08-07T10:00:00.000Z')
    insertEvent(now)
    const fetchMock = vi.fn<typeof fetch>(() => new Promise(() => {}))
    const dispatcher = startOutboxDispatcher({
      ...options(() => now, fetchMock),
      intervalMs: 1_000,
      stopTimeoutMs: 10,
      leaseMs: 100,
      fetchTimeoutMs: 50,
    })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())

    await expect(dispatcher.stop()).resolves.toBeUndefined()
  })
})
