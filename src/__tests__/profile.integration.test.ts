/**
 * Integration tests for the profile-settings feature added on top of
 * schlussel's core auth routes: GET/PATCH /auth/profile, PUT/DELETE
 * /auth/avatar, GET /auth/connected-accounts, DELETE
 * /auth/connected-accounts/:id, GET /auth/export, and the
 * sessionTimeoutMinutes → new-session-lifetime interaction.
 *
 * Written from the behavioral spec, without reading the route handler
 * bodies or the new schema columns (platform-wide "blind tests" rule).
 *
 * Isolation strategy: an exact copy of src/__tests__/auth.integration.test.ts's
 * own isolation strategy (own temp SQLite file + temp keys dir, tables wiped
 * in beforeEach), but fully independent of that file's DB/app instance so
 * the two suites never share state.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'crypto'
import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import type { Hono } from 'hono'

// ── Isolated environment ────────────────────────────────────────────────────
const testId = randomUUID().slice(0, 8)
const DB_PATH = join(tmpdir(), `schlussel-test-profile-${testId}.db`)
const KEYS_DIR = join(tmpdir(), `schlussel-keys-profile-${testId}`)
const MIGRATIONS_DIR = fileURLToPath(new URL('../db/migrations', import.meta.url))

process.env['DATABASE_PATH'] = DB_PATH
process.env['KEYS_DIR'] = KEYS_DIR
process.env['JWT_ISSUER'] = 'schlussel'

// ── Module handles populated in beforeAll ───────────────────────────────────
let app: Hono
let sqlite: import('better-sqlite3').Database

beforeAll(async () => {
  mkdirSync(KEYS_DIR, { recursive: true })

  const [keysModule, authModule, adminModule, dbModule, migratorModule, honoModule] =
    await Promise.all([
      import('../utils/keys.js'),
      import('../routes/auth.js'),
      import('../routes/admin.js'),
      import('../db/index.js'),
      import('drizzle-orm/better-sqlite3/migrator'),
      import('hono'),
    ])

  const { initKeys } = keysModule
  const { authRouter } = authModule
  const { adminRouter } = adminModule
  const { db, sqlite: sqliteInstance } = dbModule
  const { migrate } = migratorModule
  const { Hono } = honoModule

  sqlite = sqliteInstance

  await initKeys()
  migrate(db, { migrationsFolder: MIGRATIONS_DIR })

  const testApp = new Hono()
  testApp.route('/auth', authRouter)
  testApp.route('/auth', adminRouter)

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

// ── Helpers ──────────────────────────────────────────────────────────────────
const JSON_HEADERS = { 'Content-Type': 'application/json' }

function req(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>) {
  return app.request(path, {
    method,
    headers: { ...(body !== undefined ? JSON_HEADERS : {}), ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function post(path: string, body: unknown, extraHeaders?: Record<string, string>) {
  return req('POST', path, body, extraHeaders)
}
function patch(path: string, body: unknown, extraHeaders?: Record<string, string>) {
  return req('PATCH', path, body, extraHeaders)
}
function put(path: string, body: unknown, extraHeaders?: Record<string, string>) {
  return req('PUT', path, body, extraHeaders)
}
function del(path: string, extraHeaders?: Record<string, string>) {
  return req('DELETE', path, undefined, extraHeaders)
}
function get(path: string, extraHeaders?: Record<string, string>) {
  return req('GET', path, undefined, extraHeaders)
}

function authHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

async function registerUser(
  email = 'alice@example.com',
  password = 'password123',
  name = 'Alice',
  inviteCode?: string,
) {
  return post('/auth/register', { email, password, name, ...(inviteCode ? { inviteCode } : {}) })
}

// Trusted-origin header, matching how schlussel-frontend's own Caddyfile
// tags its /auth/* passthrough - required to get a real session cookie back.
async function loginUser(email = 'alice@example.com', password = 'password123') {
  return post('/auth/login', { email, password }, { 'X-Schlussel-Frontend': '1' })
}

async function mintInvite(adminAccessToken: string): Promise<string> {
  const res = await post('/auth/invites', {}, authHeader(adminAccessToken))
  const body = await res.json() as { code: string }
  return body.code
}

/** Registers+logs in a fresh first (admin) user, returns id + accessToken + cookie. */
async function bootstrapUser(email = 'alice@example.com', password = 'password123', name = 'Alice') {
  const registerRes = await registerUser(email, password, name)
  const registerBody = await registerRes.json() as Record<string, unknown>
  const loginRes = await loginUser(email, password)
  const loginBody = await loginRes.json() as Record<string, unknown>
  return {
    id: registerBody['id'] as string,
    accessToken: loginBody['accessToken'] as string,
  }
}

function getCookieValue(res: Response, cookieName: string): string | null {
  const cookies = res.headers.getSetCookie()
  for (const cookie of cookies) {
    const nameValue = cookie.split(';')[0]?.trim() ?? ''
    if (nameValue.startsWith(`${cookieName}=`)) {
      return nameValue.slice(cookieName.length + 1)
    }
  }
  return null
}

/** A short, real 1x1 transparent PNG. */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

function dataUrl(mime: string, base64: string): string {
  return `data:image/${mime};base64,${base64}`
}

/** Builds a base64 payload that decodes to roughly `bytes` bytes of data. */
function hugeBase64(bytes: number): string {
  return Buffer.alloc(bytes, 'A').toString('base64')
}

// ── GET /auth/profile ────────────────────────────────────────────────────────

describe('GET /auth/profile', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const res = await get('/auth/profile')
    expect(res.status).toBe(401)
  })

  it('returns 401 for a garbage Bearer token', async () => {
    const res = await get('/auth/profile', authHeader('thisisnotavalidtoken'))
    expect(res.status).toBe(401)
  })

  it('returns the same id/email/name/role as GET /auth/me, plus profile defaults for a freshly registered user', async () => {
    const { accessToken } = await bootstrapUser()

    const meRes = await get('/auth/me', authHeader(accessToken))
    const meBody = await meRes.json() as Record<string, unknown>

    const res = await get('/auth/profile', authHeader(accessToken))
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>

    expect(body['id']).toBe(meBody['id'])
    expect(body['email']).toBe(meBody['email'])
    expect(body['name']).toBe(meBody['name'])
    expect(body['role']).toBe(meBody['role'])

    expect(body['avatarDataUrl']).toBeNull()
    expect(body['timezone']).toBeNull()
    expect(body['dateFormat']).toBeNull()
    expect(body['weekStart']).toBeNull()
    expect(body['language']).toBeNull()
    expect(body['notifyInApp']).toBe(true)
    expect(body['notifyBrowserPush']).toBe(false)
    expect(body['notifyTelegram']).toBe(false)
    expect(body['sessionTimeoutMinutes']).toBeNull()
  })
})

// ── PATCH /auth/profile ──────────────────────────────────────────────────────

describe('PATCH /auth/profile', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const res = await patch('/auth/profile', { timezone: 'Europe/Moscow' })
    expect(res.status).toBe(401)
  })

  it('returns 401 for a garbage Bearer token', async () => {
    const res = await patch(
      '/auth/profile',
      { timezone: 'Europe/Moscow' },
      authHeader('thisisnotavalidtoken'),
    )
    expect(res.status).toBe(401)
  })

  it('returns the full updated profile, same shape as GET', async () => {
    const { accessToken } = await bootstrapUser()
    const res = await patch('/auth/profile', { timezone: 'Europe/Moscow' }, authHeader(accessToken))
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body['timezone']).toBe('Europe/Moscow')
    // Same shape as GET: every profile field present.
    for (const key of [
      'id', 'email', 'name', 'role', 'avatarDataUrl', 'timezone', 'dateFormat',
      'weekStart', 'language', 'notifyInApp', 'notifyBrowserPush', 'notifyTelegram',
      'sessionTimeoutMinutes',
    ]) {
      expect(body).toHaveProperty(key)
    }
  })

  it.each(['UTC', 'Asia/Kathmandu'])('accepts and round-trips the valid IANA timezone %s', async (timezone) => {
    const { accessToken } = await bootstrapUser()
    const res = await patch('/auth/profile', { timezone }, authHeader(accessToken))

    expect(res.status).toBe(200)
    expect((await res.json() as Record<string, unknown>)['timezone']).toBe(timezone)
  })

  it.each(['Europe/Definitely_Not_A_City', 'UTC+03:00'])(
    'rejects the non-IANA timezone %s',
    async (timezone) => {
      const { accessToken } = await bootstrapUser()
      const res = await patch('/auth/profile', { timezone }, authHeader(accessToken))

      expect(res.status).toBe(400)
      const profileRes = await get('/auth/profile', authHeader(accessToken))
      expect((await profileRes.json() as Record<string, unknown>)['timezone']).toBeNull()
    },
  )

  it('partial-update semantics: an omitted field is left untouched, and an explicit null clears it', async () => {
    const { accessToken } = await bootstrapUser()

    // 1. Set timezone.
    const res1 = await patch('/auth/profile', { timezone: 'Europe/Moscow' }, authHeader(accessToken))
    expect(res1.status).toBe(200)
    expect((await res1.json() as Record<string, unknown>)['timezone']).toBe('Europe/Moscow')

    // 2. Set weekStart, omitting timezone entirely - timezone must survive untouched.
    const res2 = await patch('/auth/profile', { weekStart: 'sunday' }, authHeader(accessToken))
    expect(res2.status).toBe(200)
    const body2 = await res2.json() as Record<string, unknown>
    expect(body2['weekStart']).toBe('sunday')
    expect(body2['timezone']).toBe('Europe/Moscow')

    // 3. A fresh GET confirms both fields.
    const getRes = await get('/auth/profile', authHeader(accessToken))
    const getBody = await getRes.json() as Record<string, unknown>
    expect(getBody['timezone']).toBe('Europe/Moscow')
    expect(getBody['weekStart']).toBe('sunday')

    // 4. Explicit null clears timezone back to null, weekStart still untouched.
    const res3 = await patch('/auth/profile', { timezone: null }, authHeader(accessToken))
    expect(res3.status).toBe(200)
    const body3 = await res3.json() as Record<string, unknown>
    expect(body3['timezone']).toBeNull()
    expect(body3['weekStart']).toBe('sunday')

    const getRes2 = await get('/auth/profile', authHeader(accessToken))
    const getBody2 = await getRes2.json() as Record<string, unknown>
    expect(getBody2['timezone']).toBeNull()
    expect(getBody2['weekStart']).toBe('sunday')
  })

  it('accepts and round-trips notification booleans', async () => {
    const { accessToken } = await bootstrapUser()
    const res = await patch(
      '/auth/profile',
      { notifyInApp: false, notifyBrowserPush: true, notifyTelegram: true },
      authHeader(accessToken),
    )
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body['notifyInApp']).toBe(false)
    expect(body['notifyBrowserPush']).toBe(true)
    expect(body['notifyTelegram']).toBe(true)
  })

  it('accepts language ru/en and clears it back to null', async () => {
    const { accessToken } = await bootstrapUser()
    const res1 = await patch('/auth/profile', { language: 'ru' }, authHeader(accessToken))
    expect(res1.status).toBe(200)
    expect((await res1.json() as Record<string, unknown>)['language']).toBe('ru')

    const res2 = await patch('/auth/profile', { language: 'en' }, authHeader(accessToken))
    expect((await res2.json() as Record<string, unknown>)['language']).toBe('en')

    const res3 = await patch('/auth/profile', { language: null }, authHeader(accessToken))
    expect((await res3.json() as Record<string, unknown>)['language']).toBeNull()
  })

  it('returns 400 for a dateFormat value outside the enum', async () => {
    const { accessToken } = await bootstrapUser()
    const res = await patch('/auth/profile', { dateFormat: 'not-a-format' }, authHeader(accessToken))
    expect(res.status).toBe(400)
  })

  it('returns 400 for a weekStart value outside the enum', async () => {
    const { accessToken } = await bootstrapUser()
    const res = await patch('/auth/profile', { weekStart: 'tuesday' }, authHeader(accessToken))
    expect(res.status).toBe(400)
  })

  it('returns 400 for a language value outside the enum', async () => {
    const { accessToken } = await bootstrapUser()
    const res = await patch('/auth/profile', { language: 'de' }, authHeader(accessToken))
    expect(res.status).toBe(400)
  })

  it('accepts valid dateFormat/weekStart enum values', async () => {
    const { accessToken } = await bootstrapUser()
    for (const dateFormat of ['dmy', 'mdy', 'ymd']) {
      const res = await patch('/auth/profile', { dateFormat }, authHeader(accessToken))
      expect(res.status).toBe(200)
      expect((await res.json() as Record<string, unknown>)['dateFormat']).toBe(dateFormat)
    }
    for (const weekStart of ['monday', 'sunday']) {
      const res = await patch('/auth/profile', { weekStart }, authHeader(accessToken))
      expect(res.status).toBe(200)
      expect((await res.json() as Record<string, unknown>)['weekStart']).toBe(weekStart)
    }
  })

  it('returns 400 for a sessionTimeoutMinutes value far too small (1)', async () => {
    const { accessToken } = await bootstrapUser()
    const res = await patch('/auth/profile', { sessionTimeoutMinutes: 1 }, authHeader(accessToken))
    expect(res.status).toBe(400)
  })

  it('returns 400 for a sessionTimeoutMinutes value far too large (999999)', async () => {
    const { accessToken } = await bootstrapUser()
    const res = await patch('/auth/profile', { sessionTimeoutMinutes: 999999 }, authHeader(accessToken))
    expect(res.status).toBe(400)
  })

  it('accepts a reasonable sessionTimeoutMinutes value (60) with 200', async () => {
    const { accessToken } = await bootstrapUser()
    const res = await patch('/auth/profile', { sessionTimeoutMinutes: 60 }, authHeader(accessToken))
    expect(res.status).toBe(200)
    expect((await res.json() as Record<string, unknown>)['sessionTimeoutMinutes']).toBe(60)
  })

  it('clears sessionTimeoutMinutes back to null with an explicit null', async () => {
    const { accessToken } = await bootstrapUser()
    await patch('/auth/profile', { sessionTimeoutMinutes: 60 }, authHeader(accessToken))
    const res = await patch('/auth/profile', { sessionTimeoutMinutes: null }, authHeader(accessToken))
    expect(res.status).toBe(200)
    expect((await res.json() as Record<string, unknown>)['sessionTimeoutMinutes']).toBeNull()
  })

  it("two different users' profile updates never leak into each other", async () => {
    const alice = await bootstrapUser('alice@example.com', 'password123', 'Alice')
    const inviteCode = await mintInvite(alice.accessToken)
    await registerUser('bob@example.com', 'bobpassword', 'Bob', inviteCode)
    const bobLogin = await loginUser('bob@example.com', 'bobpassword')
    const bobBody = await bobLogin.json() as Record<string, unknown>
    const bobToken = bobBody['accessToken'] as string

    await patch(
      '/auth/profile',
      { timezone: 'Europe/Moscow', language: 'ru', notifyTelegram: true },
      authHeader(alice.accessToken),
    )

    const bobProfileRes = await get('/auth/profile', authHeader(bobToken))
    const bobProfile = await bobProfileRes.json() as Record<string, unknown>
    expect(bobProfile['timezone']).toBeNull()
    expect(bobProfile['language']).toBeNull()
    expect(bobProfile['notifyTelegram']).toBe(false)

    const aliceProfileRes = await get('/auth/profile', authHeader(alice.accessToken))
    const aliceProfile = await aliceProfileRes.json() as Record<string, unknown>
    expect(aliceProfile['timezone']).toBe('Europe/Moscow')
    expect(aliceProfile['language']).toBe('ru')
    expect(aliceProfile['notifyTelegram']).toBe(true)
  })
})

// ── PUT /auth/avatar ─────────────────────────────────────────────────────────

describe('PUT /auth/avatar', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const res = await put('/auth/avatar', { avatarDataUrl: dataUrl('png', TINY_PNG_BASE64) })
    expect(res.status).toBe(401)
  })

  it('returns 401 for a garbage Bearer token', async () => {
    const res = await put(
      '/auth/avatar',
      { avatarDataUrl: dataUrl('png', TINY_PNG_BASE64) },
      authHeader('thisisnotavalidtoken'),
    )
    expect(res.status).toBe(401)
  })

  it('returns 400 for a garbage non-data-URL string', async () => {
    const { accessToken } = await bootstrapUser()
    const res = await put('/auth/avatar', { avatarDataUrl: 'not-a-data-url' }, authHeader(accessToken))
    expect(res.status).toBe(400)
  })

  it('accepts a tiny valid png data URL and echoes it back, 200', async () => {
    const { accessToken } = await bootstrapUser()
    const avatarDataUrl = dataUrl('png', TINY_PNG_BASE64)
    const res = await put('/auth/avatar', { avatarDataUrl }, authHeader(accessToken))
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body['avatarDataUrl']).toBe(avatarDataUrl)
  })

  it('accepts a small jpeg data URL, 200', async () => {
    const { accessToken } = await bootstrapUser()
    const avatarDataUrl = dataUrl('jpeg', hugeBase64(64))
    const res = await put('/auth/avatar', { avatarDataUrl }, authHeader(accessToken))
    expect(res.status).toBe(200)
  })

  it('accepts a small webp data URL, 200', async () => {
    const { accessToken } = await bootstrapUser()
    const avatarDataUrl = dataUrl('webp', hugeBase64(64))
    const res = await put('/auth/avatar', { avatarDataUrl }, authHeader(accessToken))
    expect(res.status).toBe(200)
  })

  it('rejects a data URL whose decoded bytes are clearly huge (several hundred KB) with 400', async () => {
    const { accessToken } = await bootstrapUser()
    const avatarDataUrl = dataUrl('png', hugeBase64(600 * 1024))
    const res = await put('/auth/avatar', { avatarDataUrl }, authHeader(accessToken))
    expect(res.status).toBe(400)
  })

  it('a subsequent GET /auth/profile reflects the newly set avatar', async () => {
    const { accessToken } = await bootstrapUser()
    const avatarDataUrl = dataUrl('png', TINY_PNG_BASE64)
    await put('/auth/avatar', { avatarDataUrl }, authHeader(accessToken))

    const res = await get('/auth/profile', authHeader(accessToken))
    const body = await res.json() as Record<string, unknown>
    expect(body['avatarDataUrl']).toBe(avatarDataUrl)
  })
})

// ── DELETE /auth/avatar ──────────────────────────────────────────────────────

describe('DELETE /auth/avatar', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const res = await del('/auth/avatar')
    expect(res.status).toBe(401)
  })

  it('returns 401 for a garbage Bearer token', async () => {
    const res = await del('/auth/avatar', authHeader('thisisnotavalidtoken'))
    expect(res.status).toBe(401)
  })

  it('clears a previously set avatar back to null, 200', async () => {
    const { accessToken } = await bootstrapUser()
    await put('/auth/avatar', { avatarDataUrl: dataUrl('png', TINY_PNG_BASE64) }, authHeader(accessToken))

    const res = await del('/auth/avatar', authHeader(accessToken))
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body['avatarDataUrl']).toBeNull()

    const getRes = await get('/auth/profile', authHeader(accessToken))
    expect((await getRes.json() as Record<string, unknown>)['avatarDataUrl']).toBeNull()
  })

  it('is idempotent: succeeds with 200 even when no avatar was ever set', async () => {
    const { accessToken } = await bootstrapUser()
    const res = await del('/auth/avatar', authHeader(accessToken))
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body['avatarDataUrl']).toBeNull()
  })
})

// ── GET /auth/connected-accounts ────────────────────────────────────────────

describe('GET /auth/connected-accounts', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const res = await get('/auth/connected-accounts')
    expect(res.status).toBe(401)
  })

  it('returns 401 for a garbage Bearer token', async () => {
    const res = await get('/auth/connected-accounts', authHeader('thisisnotavalidtoken'))
    expect(res.status).toBe(401)
  })

  it('returns an empty array for a user who has never connected anything', async () => {
    const { accessToken } = await bootstrapUser()
    const res = await get('/auth/connected-accounts', authHeader(accessToken))
    expect(res.status).toBe(200)
    const body = await res.json() as unknown
    expect(Array.isArray(body)).toBe(true)
    expect((body as unknown[]).length).toBe(0)
  })
})

// ── DELETE /auth/connected-accounts/:id ─────────────────────────────────────

describe('DELETE /auth/connected-accounts/:id', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const res = await del(`/auth/connected-accounts/${randomUUID()}`)
    expect(res.status).toBe(401)
  })

  it('returns 401 for a garbage Bearer token', async () => {
    const res = await del(`/auth/connected-accounts/${randomUUID()}`, authHeader('thisisnotavalidtoken'))
    expect(res.status).toBe(401)
  })

  it('returns 404 for a nonexistent/made-up id', async () => {
    const { accessToken } = await bootstrapUser()
    const res = await del(`/auth/connected-accounts/${randomUUID()}`, authHeader(accessToken))
    expect(res.status).toBe(404)
  })
})

// ── GET /auth/export ─────────────────────────────────────────────────────────

describe('GET /auth/export', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const res = await get('/auth/export')
    expect(res.status).toBe(401)
  })

  it('returns 401 for a garbage Bearer token', async () => {
    const res = await get('/auth/export', authHeader('thisisnotavalidtoken'))
    expect(res.status).toBe(401)
  })

  it("contains the caller's own profile data, including their email, nested somewhere in the response", async () => {
    const { accessToken } = await bootstrapUser('alice@example.com', 'password123', 'Alice')
    const res = await get('/auth/export', authHeader(accessToken))
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    const profile = body['profile'] as Record<string, unknown>
    expect(profile).toBeDefined()
    expect(profile['email']).toBe('alice@example.com')
  })

  it('has a scope field indicating this export is limited to this one service', async () => {
    const { accessToken } = await bootstrapUser()
    const res = await get('/auth/export', authHeader(accessToken))
    const body = await res.json() as Record<string, unknown>
    expect(typeof body['scope']).toBe('string')
    expect((body['scope'] as string).toLowerCase()).toMatch(/schlussel|account/i)
  })

  it("does not leak another user's data - each user's export only contains their own info", async () => {
    const alice = await bootstrapUser('alice@example.com', 'password123', 'Alice')
    const inviteCode = await mintInvite(alice.accessToken)
    await registerUser('bob@example.com', 'bobpassword', 'Bob', inviteCode)
    const bobLogin = await loginUser('bob@example.com', 'bobpassword')
    const bobBody = await bobLogin.json() as Record<string, unknown>
    const bobToken = bobBody['accessToken'] as string

    const aliceExportRes = await get('/auth/export', authHeader(alice.accessToken))
    const bobExportRes = await get('/auth/export', authHeader(bobToken))
    const aliceExport = await aliceExportRes.json() as Record<string, unknown>
    const bobExport = await bobExportRes.json() as Record<string, unknown>

    const aliceProfile = aliceExport['profile'] as Record<string, unknown>
    const bobProfile = bobExport['profile'] as Record<string, unknown>
    expect(aliceProfile['email']).toBe('alice@example.com')
    expect(bobProfile['email']).toBe('bob@example.com')

    const aliceText = JSON.stringify(aliceExport)
    const bobText = JSON.stringify(bobExport)
    expect(aliceText).not.toContain('bob@example.com')
    expect(bobText).not.toContain('alice@example.com')
  })
})

// ── sessionTimeoutMinutes → new session lifetime ────────────────────────────

describe('sessionTimeoutMinutes affects the lifetime of new sessions', () => {
  it('a session created after setting a small sessionTimeoutMinutes has a noticeably short lifetime', async () => {
    const { id: userId, accessToken } = await bootstrapUser()

    await patch('/auth/profile', { sessionTimeoutMinutes: 5 }, authHeader(accessToken))

    // A fresh login establishes a brand-new session/cookie under the new setting.
    const freshLogin = await loginUser()
    expect(freshLogin.status).toBe(200)
    expect(getCookieValue(freshLogin, 'schloss_refresh')).not.toBeNull()

    const row = sqlite
      .prepare('SELECT expires_at, created_at FROM refresh_tokens WHERE user_id = ? ORDER BY rowid DESC LIMIT 1')
      .get(userId) as { expires_at: number; created_at: number }

    const lifetimeSeconds = row.expires_at - row.created_at
    // Roughly consistent with 5 minutes (300s) - generous tolerance for
    // rounding/clock skew, but clearly not multi-day.
    expect(lifetimeSeconds).toBeGreaterThan(60)
    expect(lifetimeSeconds).toBeLessThan(30 * 60)
  })

  it('a user who never set sessionTimeoutMinutes gets the normal multi-day default lifetime', async () => {
    const { id: userId } = await bootstrapUser()

    const freshLogin = await loginUser()
    expect(freshLogin.status).toBe(200)

    const row = sqlite
      .prepare('SELECT expires_at, created_at FROM refresh_tokens WHERE user_id = ? ORDER BY rowid DESC LIMIT 1')
      .get(userId) as { expires_at: number; created_at: number }

    const lifetimeSeconds = row.expires_at - row.created_at
    // "Multi-day" - well beyond a 5-minute custom timeout, at least a full day.
    expect(lifetimeSeconds).toBeGreaterThan(24 * 60 * 60)
  })
})
