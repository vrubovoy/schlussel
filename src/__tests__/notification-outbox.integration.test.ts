import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Hono } from 'hono'

const testId = randomUUID().slice(0, 8)
const DB_PATH = join(tmpdir(), `schlussel-test-notification-outbox-${testId}.db`)
const KEYS_DIR = join(tmpdir(), `schlussel-keys-notification-outbox-${testId}`)
const MIGRATIONS_DIR = fileURLToPath(new URL('../db/migrations', import.meta.url))

process.env['DATABASE_PATH'] = DB_PATH
process.env['KEYS_DIR'] = KEYS_DIR
process.env['JWT_ISSUER'] = 'schlussel'

interface OutboxRow {
  id: string
  event_type: string
  user_id: string
  payload: string
  correlation_id: string
  state: 'pending' | 'inflight' | 'delivered' | 'permanent'
  created_at: number
  attempts: number
  next_attempt_at: number | null
  delivered_at: number | null
  last_error: string | null
}

let app: Hono
let sqlite: import('better-sqlite3').Database
let verifyPassword: (password: string, hash: string) => Promise<boolean>

beforeAll(async () => {
  mkdirSync(KEYS_DIR, { recursive: true })

  const [keysModule, authModule, passwordModule, dbModule, migratorModule, honoModule] =
    await Promise.all([
      import('../utils/keys.js'),
      import('../routes/auth.js'),
      import('../utils/password.js'),
      import('../db/index.js'),
      import('drizzle-orm/better-sqlite3/migrator'),
      import('hono'),
    ])

  sqlite = dbModule.sqlite
  verifyPassword = passwordModule.verifyPassword
  await keysModule.initKeys()
  migratorModule.migrate(dbModule.db, { migrationsFolder: MIGRATIONS_DIR })

  const testApp = new honoModule.Hono()
  testApp.route('/auth', authModule.authRouter)
  app = testApp
})

beforeEach(() => {
  sqlite.exec('DROP TRIGGER IF EXISTS fail_notification_outbox_insert')
  if (hasOutboxTable()) sqlite.exec('DELETE FROM notification_outbox')
  sqlite.exec('DELETE FROM auth_codes')
  sqlite.exec('DELETE FROM refresh_tokens')
  sqlite.exec('DELETE FROM users')
})

afterAll(() => {
  vi.unstubAllGlobals()
  try { sqlite?.close() } catch { /* ignore */ }
  try { rmSync(DB_PATH) } catch { /* ignore */ }
  try { rmSync(KEYS_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
})

function hasOutboxTable(): boolean {
  const row = sqlite.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notification_outbox'",
  ).get()
  return row !== undefined
}

function outboxRows(): OutboxRow[] {
  const exists = hasOutboxTable()
  expect(exists, 'migration must create notification_outbox').toBe(true)
  if (!exists) return []
  return sqlite.prepare('SELECT * FROM notification_outbox ORDER BY created_at, id').all() as OutboxRow[]
}

function post(path: string, body: unknown, headers?: Record<string, string>) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

function changePassword(accessToken: string, currentPassword: string, newPassword: string) {
  return app.request('/auth/password', {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ currentPassword, newPassword }),
  })
}

async function registeredSession() {
  const registerResponse = await post('/auth/register', {
    email: 'alice@example.com',
    password: 'password123',
    name: 'Alice',
  })
  expect(registerResponse.status).toBe(201)
  const user = await registerResponse.json() as { id: string }

  const loginResponse = await post(
    '/auth/login',
    { email: 'alice@example.com', password: 'password123' },
    { 'X-Schlussel-Frontend': '1' },
  )
  expect(loginResponse.status).toBe(200)
  const login = await loginResponse.json() as { accessToken: string }
  return { userId: user.id, accessToken: login.accessToken }
}

describe('password-changed notification outbox', () => {
  it('atomically records exactly one versioned event for the authenticated user', async () => {
    const { userId, accessToken } = await registeredSession()

    const response = await changePassword(accessToken, 'password123', 'newpassword123')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })

    const rows = outboxRows()
    expect(rows).toHaveLength(2)
    const passwordEvent = rows.find((row) => row.event_type === 'schlussel.security.password_changed.v1')
    const cleanupEvent = rows.find((row) => row.event_type === 'schlussel.push.session_revoked.v1')
    expect(passwordEvent).toMatchObject({
      event_type: 'schlussel.security.password_changed.v1',
      user_id: userId,
      state: 'pending',
      attempts: 0,
      delivered_at: null,
      last_error: null,
    })

    const payload = JSON.parse(passwordEvent!.payload) as Record<string, unknown>
    expect(payload).toEqual({ recipientId: userId })
    expect(passwordEvent!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    expect(passwordEvent!.correlation_id).toBe(passwordEvent!.id)
    expect(passwordEvent!.created_at).toBeGreaterThan(1_000_000_000_000)
    expect(passwordEvent!.next_attempt_at).toBe(passwordEvent!.created_at)
    expect(JSON.parse(cleanupEvent!.payload)).toMatchObject({ recipientId: userId, sessionId: expect.any(String) })
  })

  it('records no event when the current password is invalid', async () => {
    const { accessToken } = await registeredSession()

    const response = await changePassword(accessToken, 'not-the-password', 'newpassword123')

    expect(response.status).toBe(401)
    expect(outboxRows()).toHaveLength(0)
  })

  it('does not call Glocke on the password-change request path', async () => {
    const { userId, accessToken } = await registeredSession()
    const fetchMock = vi.fn().mockRejectedValue(new Error('Glocke is unavailable'))
    vi.stubGlobal('fetch', fetchMock)

    const response = await changePassword(accessToken, 'password123', 'newpassword123')

    expect(response.status).toBe(200)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(outboxRows()).toEqual(expect.arrayContaining([
      expect.objectContaining({ event_type: 'schlussel.security.password_changed.v1', user_id: userId }),
      expect.objectContaining({ event_type: 'schlussel.push.session_revoked.v1', user_id: userId }),
    ]))
  })

  it('rolls password and session effects back when the outbox insert fails', async () => {
    const { userId, accessToken } = await registeredSession()
    const exists = hasOutboxTable()
    expect(exists, 'migration must create notification_outbox').toBe(true)
    if (!exists) return

    const passwordBefore = sqlite
      .prepare('SELECT password_hash FROM users WHERE id = ?')
      .get(userId) as { password_hash: string }
    const sessionsBefore = sqlite
      .prepare('SELECT id, token_hash FROM refresh_tokens WHERE user_id = ? ORDER BY id')
      .all(userId)

    sqlite.exec(`
      CREATE TRIGGER fail_notification_outbox_insert
      BEFORE INSERT ON notification_outbox
      BEGIN
        SELECT RAISE(ABORT, 'forced outbox failure');
      END
    `)

    let response: Response
    try {
      response = await changePassword(accessToken, 'password123', 'newpassword123')
    } finally {
      sqlite.exec('DROP TRIGGER IF EXISTS fail_notification_outbox_insert')
    }

    expect(response!.status).toBeGreaterThanOrEqual(500)
    expect(response!.status).toBeLessThan(600)
    expect(response!.headers.getSetCookie()).toHaveLength(0)

    const passwordAfter = sqlite
      .prepare('SELECT password_hash FROM users WHERE id = ?')
      .get(userId) as { password_hash: string }
    const sessionsAfter = sqlite
      .prepare('SELECT id, token_hash FROM refresh_tokens WHERE user_id = ? ORDER BY id')
      .all(userId)

    expect(passwordAfter.password_hash).toBe(passwordBefore.password_hash)
    expect(await verifyPassword('password123', passwordAfter.password_hash)).toBe(true)
    expect(await verifyPassword('newpassword123', passwordAfter.password_hash)).toBe(false)
    expect(sessionsAfter).toEqual(sessionsBefore)
    expect(outboxRows()).toHaveLength(0)
  })
})
