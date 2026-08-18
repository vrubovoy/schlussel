import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Hono } from 'hono'
import { signNotificationRequest } from '@zudar107/schloss-server-kit'

const testId = randomUUID().slice(0, 8)
const DB_PATH = join(tmpdir(), `schlussel-test-internal-recipients-${testId}.db`)
const KEYS_DIR = join(tmpdir(), `schlussel-keys-internal-recipients-${testId}`)
const MIGRATIONS_DIR = fileURLToPath(new URL('../db/migrations', import.meta.url))
const SERVICE_ID = 'glocke'
const KEY_ID = 'glocke-test-key'
const HMAC_SECRET = 'test-only-internal-hmac-secret-at-least-32-bytes'

process.env['DATABASE_PATH'] = DB_PATH
process.env['KEYS_DIR'] = KEYS_DIR
process.env['JWT_ISSUER'] = 'schlussel'
process.env['GLOCKE_TO_SCHLUSSEL_HMAC_KEY_ID'] = KEY_ID
process.env['GLOCKE_TO_SCHLUSSEL_HMAC_SECRET'] = HMAC_SECRET

let app: Hono
let sqlite: import('better-sqlite3').Database

beforeAll(async () => {
  mkdirSync(KEYS_DIR, { recursive: true })

  const [keysModule, authModule, internalModule, dbModule, migratorModule, honoModule] =
    await Promise.all([
      import('../utils/keys.js'),
      import('../routes/auth.js'),
      import('../routes/internal.js'),
      import('../db/index.js'),
      import('drizzle-orm/better-sqlite3/migrator'),
      import('hono'),
    ])

  sqlite = dbModule.sqlite
  await keysModule.initKeys()
  migratorModule.migrate(dbModule.db, { migrationsFolder: MIGRATIONS_DIR })

  const testApp = new honoModule.Hono()
  testApp.route('/auth', authModule.authRouter)
  testApp.route('/internal', internalModule.createInternalRouter({
    keyId: KEY_ID,
    secret: HMAC_SECRET,
    maxSkewSeconds: 300,
  }))
  app = testApp
})

beforeEach(() => {
  sqlite.exec('DELETE FROM refresh_tokens')
  sqlite.exec('DELETE FROM users')
})

afterAll(() => {
  try { sqlite?.close() } catch { /* ignore */ }
  try { rmSync(DB_PATH) } catch { /* ignore */ }
  try { rmSync(KEYS_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
})

function post(path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function signedHeaders(path: string, overrides: Record<string, string> = {}, rawBody = '') {
  const timestamp = Math.floor(Date.now() / 1000)
  const signature = signNotificationRequest({
    secret: HMAC_SECRET,
    keyId: KEY_ID,
    source: SERVICE_ID,
    timestamp,
    method: 'GET',
    path,
    rawBody,
  })
  return {
    'X-Hof-Key-Id': KEY_ID,
    'X-Hof-Service': SERVICE_ID,
    'X-Hof-Timestamp': timestamp.toString(),
    'X-Hof-Signature': signature,
    ...overrides,
  }
}

async function registerRecipient() {
  const response = await post('/auth/register', {
    email: 'alice@example.com',
    password: 'password123',
    name: 'Alice',
  })
  expect(response.status).toBe(201)
  const user = await response.json() as { id: string }
  sqlite.prepare(
    'UPDATE users SET notify_in_app = ?, language = ?, timezone = ? WHERE id = ?',
  ).run(0, 'en', 'Europe/Berlin', user.id)
  return user.id
}

describe('GET /internal/v1/notification-recipients/:userId', () => {
  it('returns only active recipient identity and Glocke-owned preferences', async () => {
    const userId = await registerRecipient()
    const path = `/internal/v1/notification-recipients/${userId}`

    const response = await app.request(path, { headers: signedHeaders(path) })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      userId,
      notifyInApp: false,
      notifyBrowserPush: false,
      language: 'en',
      timezone: 'Europe/Berlin',
    })
  })

  // ── Browser Push delivery (issue #202): the internal contract gains
  // notifyBrowserPush, sourced from the same users row, so Glocke's
  // materialization step can gate push delivery the same way it already
  // gates notifyInApp. Written from the spec, before the field exists on
  // the response - both true/false must reflect the stored column
  // faithfully, and adding the field must not disturb any of the
  // existing auth/HMAC/404 behavior covered below.
  it('reflects notifyBrowserPush: false when the stored column is false (the default)', async () => {
    const userId = await registerRecipient()
    const path = `/internal/v1/notification-recipients/${userId}`

    const response = await app.request(path, { headers: signedHeaders(path) })

    expect(response.status).toBe(200)
    const body = await response.json() as Record<string, unknown>
    expect(body['notifyBrowserPush']).toBe(false)
  })

  it('reflects notifyBrowserPush: true when the stored column is true', async () => {
    const userId = await registerRecipient()
    sqlite.prepare('UPDATE users SET notify_browser_push = ? WHERE id = ?').run(1, userId)
    const path = `/internal/v1/notification-recipients/${userId}`

    const response = await app.request(path, { headers: signedHeaders(path) })

    expect(response.status).toBe(200)
    const body = await response.json() as Record<string, unknown>
    expect(body['notifyBrowserPush']).toBe(true)
    // The other Glocke-owned fields are untouched by this column read.
    expect(body['notifyInApp']).toBe(false)
    expect(body['language']).toBe('en')
    expect(body['timezone']).toBe('Europe/Berlin')
  })

  it.each([
    ['missing authentication', () => ({})],
    ['invalid HMAC', (path: string) => signedHeaders(path, { 'X-Hof-Signature': '0'.repeat(64) })],
    ['invalid service identity', (path: string) => signedHeaders(path, { 'X-Hof-Service': 'not-glocke' })],
  ])('rejects %s', async (_case, headersForPath) => {
    const userId = await registerRecipient()
    const path = `/internal/v1/notification-recipients/${userId}`

    const response = await app.request(path, { headers: headersForPath(path) })

    expect(response.status).toBe(401)
  })

  it('verifies the canonical signature against the exact empty GET body', async () => {
    const userId = await registerRecipient()
    const path = `/internal/v1/notification-recipients/${userId}`

    const response = await app.request(path, { headers: signedHeaders(path, {}, 'not-the-empty-body') })

    expect(response.status).toBe(401)
  })

  it('does not expose deleted recipients', async () => {
    const userId = await registerRecipient()
    sqlite.prepare('DELETE FROM users WHERE id = ?').run(userId)
    const path = `/internal/v1/notification-recipients/${userId}`

    const response = await app.request(path, { headers: signedHeaders(path) })

    expect(response.status).toBe(404)
  })
})
