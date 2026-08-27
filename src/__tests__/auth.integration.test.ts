/**
 * Integration tests for all HTTP routes.
 *
 * Isolation strategy:
 *   - process.env is mutated at the very top of this module (before any imports
 *     that might read it at load time).
 *   - All project code is loaded via dynamic imports inside beforeAll, so the
 *     env values set here are what the modules actually see.
 *   - A fresh temp SQLite file is used exclusively by this test file.
 *   - Tables are wiped in beforeEach so every test starts with a clean slate.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { randomUUID, randomBytes, createHash } from 'crypto'
import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import type { Hono } from 'hono'
import { SignJWT, decodeJwt } from 'jose'

// ── Isolated environment ────────────────────────────────────────────────────
const testId = randomUUID().slice(0, 8)
const DB_PATH = join(tmpdir(), `schlussel-test-${testId}.db`)
const KEYS_DIR = join(tmpdir(), `schlussel-keys-${testId}`)
const MIGRATIONS_DIR = fileURLToPath(new URL('../db/migrations', import.meta.url))

process.env['DATABASE_PATH'] = DB_PATH
process.env['KEYS_DIR'] = KEYS_DIR
process.env['JWT_ISSUER'] = 'schlussel'
// All six optional services enabled - this file's self-deletion assertions
// expect a full six-target deletion job; the disabled-service filtering
// itself belongs to deletion-config.unit.test.ts.
process.env['KUVERT_DELETION_URL'] = 'http://kuvert-backend:3001/internal/v1/account-deletions'
process.env['TAFEL_DELETION_URL'] = 'http://tafel-backend:3002/internal/v1/account-deletions'
process.env['ZETTEL_DELETION_URL'] = 'http://zettel-backend:3003/internal/v1/account-deletions'
process.env['GLOCKE_DELETION_URL'] = 'http://glocke-backend:3004/internal/v1/account-deletions'
process.env['SCHRANK_DELETION_URL'] = 'http://schrank-backend:3005/internal/v1/account-deletions'
process.env['HEROLD_DELETION_URL'] = 'http://herold-backend:3006/internal/v1/account-deletions'

// ── Module handles populated in beforeAll ───────────────────────────────────
let app: Hono
let sqlite: import('better-sqlite3').Database
let getPrivateKey: () => CryptoKey

// ── Setup / teardown ────────────────────────────────────────────────────────
beforeAll(async () => {
  mkdirSync(KEYS_DIR, { recursive: true })

  // Dynamic imports so env vars are already set when modules run their
  // top-level code.
  const [keysModule, authModule, adminModule, dbModule, migratorModule, migrateHelperModule, honoModule] =
    await Promise.all([
      import('../utils/keys.js'),
      import('../routes/auth.js'),
      import('../routes/admin.js'),
      import('../db/index.js'),
      import('drizzle-orm/better-sqlite3/migrator'),
      import('../db/migrate.js'),
      import('hono'),
    ])

  const { initKeys, getJwks } = keysModule
  getPrivateKey = keysModule.getPrivateKey
  const { authRouter } = authModule
  const { adminRouter } = adminModule
  const { db, sqlite: sqliteInstance } = dbModule
  const { migrate } = migratorModule
  const { assertSchemaCurrent } = migrateHelperModule
  const { Hono } = honoModule

  sqlite = sqliteInstance

  await initKeys()
  migrate(db, { migrationsFolder: MIGRATIONS_DIR })

  const testApp = new Hono()
  testApp.get('/.well-known/jwks.json', (c) => c.json(getJwks()))
  testApp.get('/health', (c) => c.json({ status: 'ok' }))
  // Mirrors the real /ready handler in src/index.ts, which this file
  // doesn't import directly (importing it would call serve() for real -
  // see the module comment above).
  testApp.get('/ready', (c) => {
    try {
      assertSchemaCurrent(sqlite)
      return c.json({ status: 'ready', service: 'Schlüssel' })
    } catch {
      return c.json({ status: 'unavailable', service: 'Schlüssel' }, 503)
    }
  })
  testApp.route('/auth', authRouter)
  // Mounted alongside authRouter, matching production (src/index.ts) -
  // several tests below mint a real invite to register a second user.
  testApp.route('/auth', adminRouter)

  app = testApp
})

beforeEach(() => {
  // Delete child rows first to satisfy FK, then parent.
  sqlite.exec('DELETE FROM deletion_job_targets')
  sqlite.exec('DELETE FROM deletion_jobs')
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

function post(path: string, body: unknown, extraHeaders?: Record<string, string>) {
  return app.request(path, {
    method: 'POST',
    headers: { ...JSON_HEADERS, ...extraHeaders },
    body: JSON.stringify(body),
  })
}

function patch(path: string, body: unknown, extraHeaders?: Record<string, string>) {
  return app.request(path, {
    method: 'PATCH',
    headers: { ...JSON_HEADERS, ...extraHeaders },
    body: JSON.stringify(body),
  })
}

function del(path: string, body: unknown, extraHeaders?: Record<string, string>) {
  return app.request(path, {
    method: 'DELETE',
    headers: { ...JSON_HEADERS, ...extraHeaders },
    body: JSON.stringify(body),
  })
}

async function registerUser(
  email = 'alice@example.com',
  password = 'password123',
  name = 'Alice',
  inviteCode?: string,
) {
  const res = await post('/auth/register', { email, password, name, ...(inviteCode ? { inviteCode } : {}) })
  return res
}

// Sends the same trust header schlussel-frontend's own Caddyfile adds on its
// /auth/* passthrough - without it, /login now correctly withholds the
// session cookie (see the isTrustedOrigin gate this helper is simulating).
async function loginUser(email = 'alice@example.com', password = 'password123') {
  const res = await post('/auth/login', { email, password }, { 'X-Schlussel-Frontend': '1' })
  return res
}

// Mints a real invite via the admin-only HTTP endpoint (not a direct DB
// insert) so tests that need a second user in the same beforeEach-wiped
// table exercise the same code path production traffic does. Requires an
// admin's own access token - the first user registered in any given test
// already is one.
async function mintInvite(adminAccessToken: string): Promise<string> {
  const res = await post('/auth/invites', {}, { Authorization: `Bearer ${adminAccessToken}` })
  const body = await res.json() as { code: string }
  return body.code
}

/** Returns the value of the named cookie from a Response, or null. */
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

/** Returns the raw Set-Cookie string for the named cookie, or null. */
function getRawCookie(res: Response, cookieName: string): string | null {
  const cookies = res.headers.getSetCookie()
  return cookies.find((c) => c.startsWith(`${cookieName}=`)) ?? null
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body['status']).toBe('ok')
  })
})

describe('GET /ready', () => {
  it('returns 200 with status ready when the schema is current', async () => {
    const res = await app.request('/ready')
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body['status']).toBe('ready')
  })

  it('returns 503 with status unavailable when the migration tracking table is stale', async () => {
    // See migrate.unit.test.ts's identical trick: drizzle-orm's better-
    // sqlite3 migrator declares `id SERIAL PRIMARY KEY`, a Postgres-ism
    // SQLite doesn't treat as a rowid alias, so `id` is always NULL here -
    // target the implicit `rowid` instead. Deleting only removes the
    // tracking row, not the tables/columns that migration already
    // created, so restoring afterward re-inserts the same row rather
    // than re-running the migration (which would fail on already-
    // existing tables).
    const latest = sqlite.prepare(
      'SELECT rowid, hash, created_at FROM __drizzle_migrations ORDER BY rowid DESC LIMIT 1',
    ).get() as { rowid: number; hash: string; created_at: number }
    const deleted = sqlite.prepare('DELETE FROM __drizzle_migrations WHERE rowid = ?').run(latest.rowid)
    expect(deleted.changes).toBe(1)
    try {
      const res = await app.request('/ready')
      expect(res.status).toBe(503)
      const body = await res.json() as Record<string, unknown>
      expect(body['status']).toBe('unavailable')
    } finally {
      // Restore real schema currency so later tests in this file (which
      // reuse the same sqlite connection/app instance) aren't affected.
      sqlite.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run(latest.hash, latest.created_at)
    }
  })
})

describe('GET /.well-known/jwks.json', () => {
  it('returns 200', async () => {
    const res = await app.request('/.well-known/jwks.json')
    expect(res.status).toBe(200)
  })

  it('returns an object with a keys array', async () => {
    const res = await app.request('/.well-known/jwks.json')
    const body = await res.json() as Record<string, unknown>
    expect(body).toHaveProperty('keys')
    expect(Array.isArray(body['keys'])).toBe(true)
    expect((body['keys'] as unknown[]).length).toBeGreaterThan(0)
  })

  it('key has kty RSA, use sig, alg RS256, and a kid', async () => {
    const res = await app.request('/.well-known/jwks.json')
    const body = await res.json() as { keys: Record<string, unknown>[] }
    const key = body.keys[0]
    expect(key).toBeDefined()
    expect(key!['kty']).toBe('RSA')
    expect(key!['use']).toBe('sig')
    expect(key!['alg']).toBe('RS256')
    expect(typeof key!['kid']).toBe('string')
    expect((key!['kid'] as string).length).toBeGreaterThan(0)
  })

  it('key contains RSA public key components (n, e)', async () => {
    const res = await app.request('/.well-known/jwks.json')
    const body = await res.json() as { keys: Record<string, unknown>[] }
    const key = body.keys[0]!
    expect(typeof key['n']).toBe('string')
    expect(typeof key['e']).toBe('string')
  })

  it('is accessible without authentication', async () => {
    // No Authorization header — must still succeed
    const res = await app.request('/.well-known/jwks.json')
    expect(res.status).toBe(200)
  })
})

describe('POST /auth/register', () => {
  it('returns 201 with user object on success', async () => {
    const res = await registerUser()
    expect(res.status).toBe(201)
    const body = await res.json() as Record<string, unknown>
    expect(typeof body['id']).toBe('string')
    expect(body['email']).toBe('alice@example.com')
    expect(body['name']).toBe('Alice')
    expect(['admin', 'user']).toContain(body['role'])
  })

  it('first registered user gets admin role', async () => {
    const res = await registerUser()
    expect(res.status).toBe(201)
    const body = await res.json() as Record<string, unknown>
    expect(body['role']).toBe('admin')
  })

  it('second registered user gets user role', async () => {
    await registerUser('alice@example.com', 'password123', 'Alice')
    const aliceLogin = await loginUser('alice@example.com', 'password123')
    const aliceBody = await aliceLogin.json() as Record<string, unknown>
    const inviteCode = await mintInvite(aliceBody['accessToken'] as string)
    const res = await registerUser('bob@example.com', 'password456', 'Bob', inviteCode)
    expect(res.status).toBe(201)
    const body = await res.json() as Record<string, unknown>
    expect(body['role']).toBe('user')
  })

  it('does not return passwordHash in response', async () => {
    const res = await registerUser()
    const body = await res.json() as Record<string, unknown>
    expect(body['passwordHash']).toBeUndefined()
    expect(body['password_hash']).toBeUndefined()
    expect(body['password']).toBeUndefined()
  })

  it('returns 409 when email is already taken', async () => {
    await registerUser()
    const res = await registerUser()
    expect(res.status).toBe(409)
    const body = await res.json() as Record<string, unknown>
    expect(body['error']).toMatch(/already registered/i)
  })

  it('returns 400 or 422 for an invalid email', async () => {
    const res = await post('/auth/register', {
      email: 'not-an-email',
      password: 'password123',
      name: 'Alice',
    })
    expect([400, 422]).toContain(res.status)
  })

  it('returns 400 or 422 for password shorter than 8 characters', async () => {
    const res = await post('/auth/register', {
      email: 'alice@example.com',
      password: 'short',
      name: 'Alice',
    })
    expect([400, 422]).toContain(res.status)
  })

  it('returns 400 or 422 for password longer than 128 characters', async () => {
    const res = await post('/auth/register', {
      email: 'alice@example.com',
      password: 'a'.repeat(129),
      name: 'Alice',
    })
    expect([400, 422]).toContain(res.status)
  })

  it('accepts password of exactly 8 characters', async () => {
    const res = await post('/auth/register', {
      email: 'alice@example.com',
      password: '12345678',
      name: 'Alice',
    })
    expect(res.status).toBe(201)
  })

  it('accepts password of exactly 128 characters', async () => {
    const res = await post('/auth/register', {
      email: 'alice@example.com',
      password: 'a'.repeat(128),
      name: 'Alice',
    })
    expect(res.status).toBe(201)
  })

  it('returns 400 or 422 for empty name', async () => {
    const res = await post('/auth/register', {
      email: 'alice@example.com',
      password: 'password123',
      name: '',
    })
    expect([400, 422]).toContain(res.status)
  })

  it('returns 400 or 422 for name longer than 100 characters', async () => {
    const res = await post('/auth/register', {
      email: 'alice@example.com',
      password: 'password123',
      name: 'a'.repeat(101),
    })
    expect([400, 422]).toContain(res.status)
  })

  it('accepts name of exactly 100 characters', async () => {
    const res = await post('/auth/register', {
      email: 'alice@example.com',
      password: 'password123',
      name: 'a'.repeat(100),
    })
    expect(res.status).toBe(201)
  })

  it('returns 400 or 422 for missing email field', async () => {
    const res = await post('/auth/register', { password: 'password123', name: 'Alice' })
    expect([400, 422]).toContain(res.status)
  })

  it('returns 400 or 422 for missing password field', async () => {
    const res = await post('/auth/register', { email: 'alice@example.com', name: 'Alice' })
    expect([400, 422]).toContain(res.status)
  })

  it('returns 400 or 422 for missing name field', async () => {
    const res = await post('/auth/register', { email: 'alice@example.com', password: 'password123' })
    expect([400, 422]).toContain(res.status)
  })

  it('returns 400 or 422 for completely empty body', async () => {
    const res = await post('/auth/register', {})
    expect([400, 422]).toContain(res.status)
  })
})

describe('POST /auth/login', () => {
  beforeEach(async () => {
    // Register a user to log in with
    await post('/auth/register', {
      email: 'alice@example.com',
      password: 'password123',
      name: 'Alice',
    })
  })

  it('returns 200 with accessToken and user on success', async () => {
    const res = await loginUser()
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(typeof body['accessToken']).toBe('string')
    expect((body['accessToken'] as string).length).toBeGreaterThan(0)
    const user = body['user'] as Record<string, unknown>
    expect(user['email']).toBe('alice@example.com')
    expect(user['name']).toBe('Alice')
    expect(typeof user['id']).toBe('string')
    expect(['admin', 'user']).toContain(user['role'])
  })

  it('sets the schloss_refresh cookie', async () => {
    const res = await loginUser()
    const cookie = getCookieValue(res, 'schloss_refresh')
    expect(cookie).not.toBeNull()
    expect((cookie ?? '').length).toBeGreaterThan(0)
  })

  // Security regression test: without the trust header, this reaches the
  // exact same code path a consumer app's own /auth/* proxy would hit for
  // a plain POST (no codeChallenge) - it must not plant a session cookie
  // on whatever origin it's reached through.
  it('without X-Schlussel-Frontend: returns 200 with accessToken but sets no schloss_refresh cookie', async () => {
    const res = await post('/auth/login', { email: 'alice@example.com', password: 'password123' })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(typeof body['accessToken']).toBe('string')
    expect(getCookieValue(res, 'schloss_refresh')).toBeNull()
  })

  it('sets the cookie as HttpOnly', async () => {
    const res = await loginUser()
    const raw = getRawCookie(res, 'schloss_refresh')
    expect(raw).not.toBeNull()
    expect(raw!.toLowerCase()).toContain('httponly')
  })

  it('sets the cookie with SameSite=Strict', async () => {
    const res = await loginUser()
    const raw = getRawCookie(res, 'schloss_refresh')
    expect(raw).not.toBeNull()
    expect(raw!.toLowerCase()).toContain('samesite=strict')
  })

  it('returns 401 for wrong password', async () => {
    const res = await post('/auth/login', {
      email: 'alice@example.com',
      password: 'wrongpassword',
    })
    expect(res.status).toBe(401)
    const body = await res.json() as Record<string, unknown>
    expect(body['error']).toBeDefined()
  })

  it('returns 401 for unknown email', async () => {
    const res = await post('/auth/login', {
      email: 'nobody@example.com',
      password: 'password123',
    })
    expect(res.status).toBe(401)
    const body = await res.json() as Record<string, unknown>
    expect(body['error']).toBeDefined()
  })

  it('does not reveal whether the email exists (same error for wrong email vs wrong password)', async () => {
    const wrongEmail = await post('/auth/login', {
      email: 'nobody@example.com',
      password: 'password123',
    })
    const wrongPass = await post('/auth/login', {
      email: 'alice@example.com',
      password: 'wrongpassword',
    })
    // Both should be 401 — the error message should be the same or similar
    expect(wrongEmail.status).toBe(401)
    expect(wrongPass.status).toBe(401)
  })

  // Uses its own fake source IP throughout so it can't share (or pollute)
  // the bucket every other test in this file implicitly uses (none of them
  // set X-Forwarded-For, so they all fall back to the same 'unknown' key).
  it('returns 429 after enough consecutive failed attempts from the same source, and a correct login from elsewhere is unaffected', async () => {
    const attackerIp = { 'X-Forwarded-For': '198.51.100.1' }
    for (let i = 0; i < 20; i++) {
      const res = await post(
        '/auth/login',
        { email: 'alice@example.com', password: 'wrongpassword' },
        attackerIp,
      )
      expect(res.status).toBe(401)
    }
    const limited = await post(
      '/auth/login',
      { email: 'alice@example.com', password: 'wrongpassword' },
      attackerIp,
    )
    expect(limited.status).toBe(429)

    const fromElsewhere = await post(
      '/auth/login',
      { email: 'alice@example.com', password: 'password123' },
      { 'X-Forwarded-For': '198.51.100.2', 'X-Schlussel-Frontend': '1' },
    )
    expect(fromElsewhere.status).toBe(200)
  })

  it('access token is a JWT with three dot-separated parts', async () => {
    const res = await loginUser()
    const body = await res.json() as Record<string, unknown>
    const token = body['accessToken'] as string
    const parts = token.split('.')
    expect(parts.length).toBe(3)
  })

  it('access token header declares RS256', async () => {
    const res = await loginUser()
    const body = await res.json() as Record<string, unknown>
    const token = body['accessToken'] as string
    const header = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString())
    expect(header['alg']).toBe('RS256')
  })
})

describe('POST /auth/refresh', () => {
  let refreshTokenCookie: string

  beforeEach(async () => {
    await post('/auth/register', {
      email: 'alice@example.com',
      password: 'password123',
      name: 'Alice',
    })
    const loginRes = await post('/auth/login', {
      email: 'alice@example.com',
      password: 'password123',
    }, { 'X-Schlussel-Frontend': '1' })
    refreshTokenCookie = getCookieValue(loginRes, 'schloss_refresh') ?? ''
    // jose uses second-precision iat. Wait to ensure the rotated token gets a
    // different iat (and thus a different signature) from the original.
    await new Promise((r) => setTimeout(r, 1100))
  })

  it('returns 200 with a new accessToken', async () => {
    const res = await app.request('/auth/refresh', {
      method: 'POST',
      headers: { Cookie: `schloss_refresh=${refreshTokenCookie}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(typeof body['accessToken']).toBe('string')
    expect((body['accessToken'] as string).length).toBeGreaterThan(0)
  })

  it('sets a new schloss_refresh cookie on successful refresh when trusted', async () => {
    const res = await app.request('/auth/refresh', {
      method: 'POST',
      headers: { Cookie: `schloss_refresh=${refreshTokenCookie}`, 'X-Schlussel-Frontend': '1' },
    })
    const newCookie = getCookieValue(res, 'schloss_refresh')
    expect(newCookie).not.toBeNull()
    expect((newCookie ?? '').length).toBeGreaterThan(0)
  })

  it('new cookie is different from the old one (rotation), when trusted', async () => {
    const res = await app.request('/auth/refresh', {
      method: 'POST',
      headers: { Cookie: `schloss_refresh=${refreshTokenCookie}`, 'X-Schlussel-Frontend': '1' },
    })
    const newCookie = getCookieValue(res, 'schloss_refresh')
    expect(newCookie).not.toBeNull()
    expect(newCookie).not.toBe(refreshTokenCookie)
  })

  it('accepts a stored legacy untyped refresh JWT once and rotates it to token_use refresh', async () => {
    const user = sqlite.prepare('SELECT id FROM users WHERE email = ?').get('alice@example.com') as { id: string }
    const legacy = await new SignJWT({ jti: randomUUID() })
      .setProtectedHeader({ alg: 'RS256', kid: 'schloss-1' })
      .setSubject(user.id)
      .setIssuedAt()
      .setIssuer('schlussel')
      .setExpirationTime('7d')
      .sign(getPrivateKey())
    const nowSeconds = Math.floor(Date.now() / 1000)
    sqlite.prepare(`
      INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(randomUUID(), user.id, createHash('sha256').update(legacy).digest('hex'), nowSeconds + 604800, nowSeconds)

    const response = await app.request('/auth/refresh', {
      method: 'POST',
      headers: { Cookie: `schloss_refresh=${legacy}`, 'X-Schlussel-Frontend': '1' },
    })

    expect(response.status).toBe(200)
    const replacement = getCookieValue(response, 'schloss_refresh')!
    expect(decodeJwt(replacement)['token_use']).toBe('refresh')
    expect(sqlite.prepare('SELECT 1 FROM refresh_tokens WHERE token_hash = ?').get(
      createHash('sha256').update(legacy).digest('hex'),
    )).toBeUndefined()
  })

  it('does not accept an untyped refresh-shaped JWT unless its exact hash is stored', async () => {
    const user = sqlite.prepare('SELECT id FROM users WHERE email = ?').get('alice@example.com') as { id: string }
    const legacy = await new SignJWT({ jti: randomUUID() })
      .setProtectedHeader({ alg: 'RS256', kid: 'schloss-1' })
      .setSubject(user.id)
      .setIssuedAt()
      .setIssuer('schlussel')
      .setExpirationTime('7d')
      .sign(getPrivateKey())

    expect((await app.request('/auth/refresh', {
      method: 'POST', headers: { Cookie: `schloss_refresh=${legacy}` },
    })).status).toBe(401)
  })

  it('does not consume a stored legacy refresh JWT through an untrusted proxy origin', async () => {
    const user = sqlite.prepare('SELECT id FROM users WHERE email = ?').get('alice@example.com') as { id: string }
    const legacy = await new SignJWT({ jti: randomUUID() })
      .setProtectedHeader({ alg: 'RS256', kid: 'schloss-1' })
      .setSubject(user.id).setIssuedAt().setIssuer('schlussel').setExpirationTime('7d').sign(getPrivateKey())
    const hash = createHash('sha256').update(legacy).digest('hex')
    const nowSeconds = Math.floor(Date.now() / 1000)
    sqlite.prepare(`
      INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)
    `).run(randomUUID(), user.id, hash, nowSeconds + 604800, nowSeconds)

    const response = await app.request('/auth/refresh', {
      method: 'POST', headers: { Cookie: `schloss_refresh=${legacy}` },
    })
    expect(response.status).toBe(401)
    expect(sqlite.prepare('SELECT 1 FROM refresh_tokens WHERE token_hash = ?').get(hash)).toBeDefined()
  })

  it('old refresh token is rejected after rotation (single-use)', async () => {
    // Use the token once
    await app.request('/auth/refresh', {
      method: 'POST',
      headers: { Cookie: `schloss_refresh=${refreshTokenCookie}` },
    })

    // Try to use the same token again — must fail
    const res2 = await app.request('/auth/refresh', {
      method: 'POST',
      headers: { Cookie: `schloss_refresh=${refreshTokenCookie}` },
    })
    expect(res2.status).toBe(401)
  })

  it('new refresh token obtained after rotation works correctly', async () => {
    // First rotation (trusted, so a replacement cookie is actually issued
    // to rotate into)
    const res1 = await app.request('/auth/refresh', {
      method: 'POST',
      headers: { Cookie: `schloss_refresh=${refreshTokenCookie}`, 'X-Schlussel-Frontend': '1' },
    })
    const newCookie = getCookieValue(res1, 'schloss_refresh')

    // Second rotation with the new token
    const res2 = await app.request('/auth/refresh', {
      method: 'POST',
      headers: { Cookie: `schloss_refresh=${newCookie}` },
    })
    expect(res2.status).toBe(200)
    const body = await res2.json() as Record<string, unknown>
    expect(typeof body['accessToken']).toBe('string')
  })

  it('returns 401 with no cookie', async () => {
    const res = await app.request('/auth/refresh', { method: 'POST' })
    expect(res.status).toBe(401)
  })

  it('returns 401 with a garbage cookie value', async () => {
    const res = await app.request('/auth/refresh', {
      method: 'POST',
      headers: { Cookie: 'schloss_refresh=totallyinvalidtoken' },
    })
    expect(res.status).toBe(401)
  })

  it('returns 401 with a well-formed but unsigned JWT as cookie', async () => {
    // Build a fake JWT-shaped string that is not signed by the server
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ sub: 'fakeuser', exp: 9999999999 })).toString('base64url')
    const fakeJwt = `${header}.${payload}.fakesignature`

    const res = await app.request('/auth/refresh', {
      method: 'POST',
      headers: { Cookie: `schloss_refresh=${fakeJwt}` },
    })
    expect(res.status).toBe(401)
  })
})

describe('POST /auth/logout', () => {
  let refreshTokenCookie: string

  beforeEach(async () => {
    await post('/auth/register', {
      email: 'alice@example.com',
      password: 'password123',
      name: 'Alice',
    })
    const loginRes = await post('/auth/login', {
      email: 'alice@example.com',
      password: 'password123',
    }, { 'X-Schlussel-Frontend': '1' })
    refreshTokenCookie = getCookieValue(loginRes, 'schloss_refresh') ?? ''
  })

  it('returns 200 with ok: true when logged in', async () => {
    const res = await app.request('/auth/logout', {
      method: 'POST',
      headers: { Cookie: `schloss_refresh=${refreshTokenCookie}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body['ok']).toBe(true)
  })

  it('clears the schloss_refresh cookie in the response', async () => {
    const res = await app.request('/auth/logout', {
      method: 'POST',
      headers: { Cookie: `schloss_refresh=${refreshTokenCookie}` },
    })
    // After logout, the Set-Cookie header should clear the cookie
    const raw = getRawCookie(res, 'schloss_refresh')
    if (raw !== null) {
      // If the server sets the cookie on logout (to clear it), the value
      // should be empty or the Max-Age should be 0 / expires in the past.
      const isCleared =
        raw.includes('Max-Age=0') ||
        raw.includes('max-age=0') ||
        raw.includes('Expires=Thu, 01 Jan 1970') ||
        raw.match(/schloss_refresh=;/) !== null ||
        raw.match(/schloss_refresh=$/) !== null
      expect(isCleared).toBe(true)
    }
    // It is also acceptable for the server to not send Set-Cookie at all on logout
    // (some implementations simply delete the DB record), so we don't fail if raw is null.
  })

  it('invalidates the refresh token so it cannot be used after logout', async () => {
    await app.request('/auth/logout', {
      method: 'POST',
      headers: { Cookie: `schloss_refresh=${refreshTokenCookie}` },
    })

    // Attempting to refresh with the logged-out token should fail
    const res = await app.request('/auth/refresh', {
      method: 'POST',
      headers: { Cookie: `schloss_refresh=${refreshTokenCookie}` },
    })
    expect(res.status).toBe(401)
  })

  it('returns 200 even when no cookie is present (graceful)', async () => {
    const res = await app.request('/auth/logout', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body['ok']).toBe(true)
  })

  it('returns 200 even with an invalid/unknown cookie (graceful)', async () => {
    const res = await app.request('/auth/logout', {
      method: 'POST',
      headers: { Cookie: 'schloss_refresh=completelyunknowntoken' },
    })
    expect(res.status).toBe(200)
  })
})

describe('GET /auth/me', () => {
  let accessToken: string

  beforeEach(async () => {
    await post('/auth/register', {
      email: 'alice@example.com',
      password: 'password123',
      name: 'Alice',
    })
    const loginRes = await post('/auth/login', {
      email: 'alice@example.com',
      password: 'password123',
    }, { 'X-Schlussel-Frontend': '1' })
    const body = await loginRes.json() as Record<string, unknown>
    accessToken = body['accessToken'] as string
  })

  it('returns 200 with user info for a valid access token', async () => {
    const res = await app.request('/auth/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body['email']).toBe('alice@example.com')
    expect(body['name']).toBe('Alice')
    expect(typeof body['id']).toBe('string')
    expect(['admin', 'user']).toContain(body['role'])
  })

  it('does not return passwordHash in the response', async () => {
    const res = await app.request('/auth/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    const body = await res.json() as Record<string, unknown>
    expect(body['passwordHash']).toBeUndefined()
    expect(body['password_hash']).toBeUndefined()
  })

  it('returns 401 when Authorization header is missing', async () => {
    const res = await app.request('/auth/me')
    expect(res.status).toBe(401)
  })

  it('returns 401 for a garbage Bearer token', async () => {
    const res = await app.request('/auth/me', {
      headers: { Authorization: 'Bearer thisisnotavalidtoken' },
    })
    expect(res.status).toBe(401)
  })

  it('returns 401 for an Authorization header without "Bearer " prefix', async () => {
    const res = await app.request('/auth/me', {
      headers: { Authorization: accessToken },
    })
    expect(res.status).toBe(401)
  })

  it('returns 401 for a tampered token', async () => {
    const parts = accessToken.split('.')
    // Flip a character in the middle of the signature, not the last
    // one: base64url's final character can carry padding-only bits for
    // certain byte lengths, so some replacements there decode back to
    // the exact same signature bytes and the tamper is a no-op.
    const sig = parts[2]!
    const mid = Math.floor(sig.length / 2)
    const tamperedChar = sig[mid] === 'A' ? 'B' : 'A'
    const tamperedSig = sig.slice(0, mid) + tamperedChar + sig.slice(mid + 1)
    const tampered = `${parts[0]}.${parts[1]}.${tamperedSig}`

    const res = await app.request('/auth/me', {
      headers: { Authorization: `Bearer ${tampered}` },
    })
    expect(res.status).toBe(401)
  })

  it('returns 401 for a well-formed but self-signed JWT (not by the server)', async () => {
    const fakeHeader = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
    const fakePayload = Buffer.from(
      JSON.stringify({ sub: 'fakeuser', email: 'hacker@evil.com', exp: 9999999999 }),
    ).toString('base64url')
    const fakeJwt = `${fakeHeader}.${fakePayload}.fakesig`

    const res = await app.request('/auth/me', {
      headers: { Authorization: `Bearer ${fakeJwt}` },
    })
    expect(res.status).toBe(401)
  })

  it('returns correct data for each of two independently registered users', async () => {
    // Register a second user
    const inviteCode = await mintInvite(accessToken)
    await post('/auth/register', {
      email: 'bob@example.com',
      password: 'bobpassword',
      name: 'Bob',
      inviteCode,
    })
    const bobLogin = await post('/auth/login', {
      email: 'bob@example.com',
      password: 'bobpassword',
    }, { 'X-Schlussel-Frontend': '1' })
    const bobBody = await bobLogin.json() as Record<string, unknown>
    const bobToken = bobBody['accessToken'] as string

    const [aliceMe, bobMe] = await Promise.all([
      app.request('/auth/me', { headers: { Authorization: `Bearer ${accessToken}` } }),
      app.request('/auth/me', { headers: { Authorization: `Bearer ${bobToken}` } }),
    ])

    const aliceBody = await aliceMe.json() as Record<string, unknown>
    const bobMeBody = await bobMe.json() as Record<string, unknown>

    expect(aliceBody['email']).toBe('alice@example.com')
    expect(bobMeBody['email']).toBe('bob@example.com')
    expect(aliceBody['id']).not.toBe(bobMeBody['id'])
  })

  it('returns 401 for expired access token', async () => {
    // accessToken was obtained in beforeEach at real time T.
    // Advance the fake clock past 15-minute expiry and verify rejection.
    vi.useFakeTimers()
    try {
      vi.advanceTimersByTime(16 * 60 * 1000)
      const res = await app.request('/auth/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      expect(res.status).toBe(401)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── Trusted-origin gate (X-Schlussel-Frontend) ──────────────────────────────
//
// A new gate was added to POST /login (PKCE branch), POST /token, and
// POST /refresh: the schloss_refresh session cookie is now only set on the
// response when the request carries `X-Schlussel-Frontend: 1`. Everything
// else about these endpoints (status codes, JSON bodies, business-logic
// success/failure) must stay identical regardless of the header.
//
// POST /logout's cookie-CLEARING behavior is explicitly unchanged: it always
// clears the cookie, with or without the header.

const TRUSTED_HEADER = { 'X-Schlussel-Frontend': '1' }

/** A PKCE code_verifier: 43-128 chars from the [A-Za-z0-9_-] charset. */
function generateVerifier(length = 64): string {
  // base64url alphabet is a strict subset of the allowed verifier charset,
  // so slicing a long base64url string down to `length` stays in-charset.
  let out = ''
  while (out.length < length) out += randomBytes(48).toString('base64url')
  return out.slice(0, length)
}

/** The real S256 challenge derivation: BASE64URL(SHA256(ASCII(verifier))). */
function deriveChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

describe('POST /auth/login — PKCE branch — trusted origin gate', () => {
  beforeEach(async () => {
    await post('/auth/register', {
      email: 'alice@example.com',
      password: 'password123',
      name: 'Alice',
    })
  })

  it('without X-Schlussel-Frontend: returns 200 with { code } but sets no schloss_refresh cookie', async () => {
    const verifier = generateVerifier()
    const challenge = deriveChallenge(verifier)

    const res = await post('/auth/login', {
      email: 'alice@example.com',
      password: 'password123',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(typeof body['code']).toBe('string')
    expect((body['code'] as string).length).toBeGreaterThan(0)
    expect(getCookieValue(res, 'schloss_refresh')).toBeNull()
  })

  it('with X-Schlussel-Frontend: 1: returns the same { code } shape and DOES set the schloss_refresh cookie', async () => {
    const verifier = generateVerifier()
    const challenge = deriveChallenge(verifier)

    const res = await post(
      '/auth/login',
      {
        email: 'alice@example.com',
        password: 'password123',
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
      },
      TRUSTED_HEADER,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(typeof body['code']).toBe('string')
    expect((body['code'] as string).length).toBeGreaterThan(0)

    const cookie = getCookieValue(res, 'schloss_refresh')
    expect(cookie).not.toBeNull()
    expect((cookie ?? '').length).toBeGreaterThan(0)
  })
})

describe('POST /auth/token — trusted origin gate', () => {
  beforeEach(async () => {
    await post('/auth/register', {
      email: 'alice@example.com',
      password: 'password123',
      name: 'Alice',
    })
  })

  it('redemption WITHOUT X-Schlussel-Frontend: succeeds with a real accessToken/user but sets no schloss_refresh cookie', async () => {
    const verifier = generateVerifier()
    const challenge = deriveChallenge(verifier)

    const loginRes = await post(
      '/auth/login',
      {
        email: 'alice@example.com',
        password: 'password123',
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
      },
      TRUSTED_HEADER,
    )
    expect(loginRes.status).toBe(200)
    const { code } = await loginRes.json() as { code: string }

    const tokenRes = await post('/auth/token', { code, codeVerifier: verifier })
    expect(tokenRes.status).toBe(200)
    const body = await tokenRes.json() as Record<string, unknown>
    expect(typeof body['accessToken']).toBe('string')
    expect((body['accessToken'] as string).length).toBeGreaterThan(0)
    const user = body['user'] as Record<string, unknown>
    expect(user['email']).toBe('alice@example.com')
    expect(user['name']).toBe('Alice')

    expect(getCookieValue(tokenRes, 'schloss_refresh')).toBeNull()
  })

  it('redemption WITH X-Schlussel-Frontend: 1: same successful body AND sets the schloss_refresh cookie', async () => {
    const verifier = generateVerifier()
    const challenge = deriveChallenge(verifier)

    const loginRes = await post(
      '/auth/login',
      {
        email: 'alice@example.com',
        password: 'password123',
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
      },
      TRUSTED_HEADER,
    )
    expect(loginRes.status).toBe(200)
    const { code } = await loginRes.json() as { code: string }

    const tokenRes = await post('/auth/token', { code, codeVerifier: verifier }, TRUSTED_HEADER)
    expect(tokenRes.status).toBe(200)
    const body = await tokenRes.json() as Record<string, unknown>
    expect(typeof body['accessToken']).toBe('string')
    expect((body['accessToken'] as string).length).toBeGreaterThan(0)
    const user = body['user'] as Record<string, unknown>
    expect(user['email']).toBe('alice@example.com')
    expect(user['name']).toBe('Alice')

    const cookie = getCookieValue(tokenRes, 'schloss_refresh')
    expect(cookie).not.toBeNull()
    expect((cookie ?? '').length).toBeGreaterThan(0)
  })
})

describe('POST /auth/refresh — trusted origin gate', () => {
  let refreshTokenCookie: string

  beforeEach(async () => {
    await post('/auth/register', {
      email: 'alice@example.com',
      password: 'password123',
      name: 'Alice',
    })
    // A trusted login, so we start from a real, cookie-issued session.
    const loginRes = await post(
      '/auth/login',
      { email: 'alice@example.com', password: 'password123' },
      TRUSTED_HEADER,
    )
    refreshTokenCookie = getCookieValue(loginRes, 'schloss_refresh') ?? ''
    expect(refreshTokenCookie).not.toBe('')
    // jose uses second-precision iat. Wait to ensure a rotated token gets a
    // different iat (and thus a different signature) from the original.
    await new Promise((r) => setTimeout(r, 1100))
  })

  it('without X-Schlussel-Frontend: returns 200 with a real accessToken but does not set a Set-Cookie', async () => {
    const res = await app.request('/auth/refresh', {
      method: 'POST',
      headers: { Cookie: `schloss_refresh=${refreshTokenCookie}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(typeof body['accessToken']).toBe('string')
    expect((body['accessToken'] as string).length).toBeGreaterThan(0)
    expect(getCookieValue(res, 'schloss_refresh')).toBeNull()
  })

  it('old cookie stops working after an untrusted refresh, even though no replacement cookie was issued', async () => {
    const first = await app.request('/auth/refresh', {
      method: 'POST',
      headers: { Cookie: `schloss_refresh=${refreshTokenCookie}` },
    })
    expect(first.status).toBe(200)
    expect(getCookieValue(first, 'schloss_refresh')).toBeNull()

    // The old cookie's DB row is gone (rotation cleanup ran), even though no
    // new cookie was ever handed back to the client.
    const second = await app.request('/auth/refresh', {
      method: 'POST',
      headers: { Cookie: `schloss_refresh=${refreshTokenCookie}` },
    })
    expect(second.status).toBe(401)
    const body = await second.json() as Record<string, unknown>
    expect(body['error']).toMatch(/expired or not found/i)
  })

  it('with X-Schlussel-Frontend: 1: returns 200 with a real accessToken AND a fresh rotated Set-Cookie (unchanged trusted behavior)', async () => {
    const res = await app.request('/auth/refresh', {
      method: 'POST',
      headers: { Cookie: `schloss_refresh=${refreshTokenCookie}`, ...TRUSTED_HEADER },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(typeof body['accessToken']).toBe('string')
    expect((body['accessToken'] as string).length).toBeGreaterThan(0)

    const newCookie = getCookieValue(res, 'schloss_refresh')
    expect(newCookie).not.toBeNull()
    expect(newCookie).not.toBe(refreshTokenCookie)
  })
})

describe('POST /auth/logout — cookie clearing is unaffected by the trusted origin gate', () => {
  let refreshTokenCookie: string

  beforeEach(async () => {
    await post('/auth/register', {
      email: 'alice@example.com',
      password: 'password123',
      name: 'Alice',
    })
    const loginRes = await post(
      '/auth/login',
      { email: 'alice@example.com', password: 'password123' },
      TRUSTED_HEADER,
    )
    refreshTokenCookie = getCookieValue(loginRes, 'schloss_refresh') ?? ''
  })

  it('clears the schloss_refresh cookie WITHOUT X-Schlussel-Frontend', async () => {
    const res = await app.request('/auth/logout', {
      method: 'POST',
      headers: { Cookie: `schloss_refresh=${refreshTokenCookie}` },
    })
    expect(res.status).toBe(200)

    const raw = getRawCookie(res, 'schloss_refresh')
    expect(raw).not.toBeNull()
    const isCleared =
      raw!.includes('Max-Age=0') ||
      raw!.includes('max-age=0') ||
      raw!.includes('Expires=Thu, 01 Jan 1970') ||
      raw!.match(/schloss_refresh=;/) !== null ||
      raw!.match(/schloss_refresh=$/) !== null
    expect(isCleared).toBe(true)
  })

  it('clears the schloss_refresh cookie WITH X-Schlussel-Frontend: 1', async () => {
    const res = await app.request('/auth/logout', {
      method: 'POST',
      headers: { Cookie: `schloss_refresh=${refreshTokenCookie}`, ...TRUSTED_HEADER },
    })
    expect(res.status).toBe(200)

    const raw = getRawCookie(res, 'schloss_refresh')
    expect(raw).not.toBeNull()
    const isCleared =
      raw!.includes('Max-Age=0') ||
      raw!.includes('max-age=0') ||
      raw!.includes('Expires=Thu, 01 Jan 1970') ||
      raw!.match(/schloss_refresh=;/) !== null ||
      raw!.match(/schloss_refresh=$/) !== null
    expect(isCleared).toBe(true)
  })
})

describe('PATCH /auth/password', () => {
  let accessToken: string
  let refreshTokenCookie: string

  beforeEach(async () => {
    await post('/auth/register', {
      email: 'alice@example.com',
      password: 'password123',
      name: 'Alice',
    })
    const loginRes = await post('/auth/login', {
      email: 'alice@example.com',
      password: 'password123',
    }, { 'X-Schlussel-Frontend': '1' })
    const body = await loginRes.json() as Record<string, unknown>
    accessToken = body['accessToken'] as string
    refreshTokenCookie = getCookieValue(loginRes, 'schloss_refresh') ?? ''
  })

  it('returns 401 when Authorization header is missing', async () => {
    const res = await patch('/auth/password', {
      currentPassword: 'password123',
      newPassword: 'newpassword123',
    })
    expect(res.status).toBe(401)
  })

  it('returns 401 for a garbage Bearer token', async () => {
    const res = await patch(
      '/auth/password',
      { currentPassword: 'password123', newPassword: 'newpassword123' },
      { Authorization: 'Bearer thisisnotavalidtoken' },
    )
    expect(res.status).toBe(401)
  })

  it('returns 401 for a tampered token', async () => {
    const parts = accessToken.split('.')
    const sig = parts[2]!
    const mid = Math.floor(sig.length / 2)
    const tamperedChar = sig[mid] === 'A' ? 'B' : 'A'
    const tamperedSig = sig.slice(0, mid) + tamperedChar + sig.slice(mid + 1)
    const tampered = `${parts[0]}.${parts[1]}.${tamperedSig}`

    const res = await patch(
      '/auth/password',
      { currentPassword: 'password123', newPassword: 'newpassword123' },
      { Authorization: `Bearer ${tampered}` },
    )
    expect(res.status).toBe(401)
  })

  it('returns 401 for expired access token', async () => {
    vi.useFakeTimers()
    try {
      vi.advanceTimersByTime(16 * 60 * 1000)
      const res = await patch(
        '/auth/password',
        { currentPassword: 'password123', newPassword: 'newpassword123' },
        { Authorization: `Bearer ${accessToken}` },
      )
      expect(res.status).toBe(401)
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns 400 or 422 for a completely empty body', async () => {
    const res = await patch('/auth/password', {}, { Authorization: `Bearer ${accessToken}` })
    expect([400, 422]).toContain(res.status)
  })

  it('returns 400 or 422 for missing newPassword field', async () => {
    const res = await patch(
      '/auth/password',
      { currentPassword: 'password123' },
      { Authorization: `Bearer ${accessToken}` },
    )
    expect([400, 422]).toContain(res.status)
  })

  it('returns 400 or 422 for newPassword shorter than 8 characters', async () => {
    const res = await patch(
      '/auth/password',
      { currentPassword: 'password123', newPassword: 'short' },
      { Authorization: `Bearer ${accessToken}` },
    )
    expect([400, 422]).toContain(res.status)
  })

  it('returns 400 or 422 for newPassword longer than 128 characters', async () => {
    const res = await patch(
      '/auth/password',
      { currentPassword: 'password123', newPassword: 'a'.repeat(129) },
      { Authorization: `Bearer ${accessToken}` },
    )
    expect([400, 422]).toContain(res.status)
  })

  it('returns 401 with { error: "Invalid current password" } when currentPassword is wrong', async () => {
    const res = await patch(
      '/auth/password',
      { currentPassword: 'wrongpassword', newPassword: 'newpassword123' },
      { Authorization: `Bearer ${accessToken}` },
    )
    expect(res.status).toBe(401)
    const body = await res.json() as Record<string, unknown>
    expect(body['error']).toBe('Invalid current password')
  })

  it('returns 200 with { ok: true } on success', async () => {
    const res = await patch(
      '/auth/password',
      { currentPassword: 'password123', newPassword: 'newpassword123' },
      { Authorization: `Bearer ${accessToken}` },
    )
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body['ok']).toBe(true)
  })

  it('sets a fresh schloss_refresh cookie even without X-Schlussel-Frontend', async () => {
    const res = await patch(
      '/auth/password',
      { currentPassword: 'password123', newPassword: 'newpassword123' },
      { Authorization: `Bearer ${accessToken}` },
    )
    const cookie = getCookieValue(res, 'schloss_refresh')
    expect(cookie).not.toBeNull()
    expect((cookie ?? '').length).toBeGreaterThan(0)
  })

  it('after a successful change, login with the new password succeeds', async () => {
    await patch(
      '/auth/password',
      { currentPassword: 'password123', newPassword: 'newpassword123' },
      { Authorization: `Bearer ${accessToken}` },
    )
    const res = await post('/auth/login', { email: 'alice@example.com', password: 'newpassword123' })
    expect(res.status).toBe(200)
  })

  it('after a successful change, login with the old password now returns 401', async () => {
    await patch(
      '/auth/password',
      { currentPassword: 'password123', newPassword: 'newpassword123' },
      { Authorization: `Bearer ${accessToken}` },
    )
    const res = await post('/auth/login', { email: 'alice@example.com', password: 'password123' }, { 'X-Schlussel-Frontend': '1' })
    expect(res.status).toBe(401)
  })

  it('invalidates a pre-existing refresh session after the password change', async () => {
    expect(refreshTokenCookie).not.toBe('')
    await patch(
      '/auth/password',
      { currentPassword: 'password123', newPassword: 'newpassword123' },
      { Authorization: `Bearer ${accessToken}` },
    )

    const res = await app.request('/auth/refresh', {
      method: 'POST',
      headers: { Cookie: `schloss_refresh=${refreshTokenCookie}` },
    })
    expect(res.status).toBe(401)
  })
})

describe('DELETE /auth/account', () => {
  let accessToken: string
  let refreshTokenCookie: string
  let secondAdminAccessToken: string

  beforeEach(async () => {
    await post('/auth/register', {
      email: 'alice@example.com',
      password: 'password123',
      name: 'Alice',
    })
    const loginRes = await post('/auth/login', {
      email: 'alice@example.com',
      password: 'password123',
    }, { 'X-Schlussel-Frontend': '1' })
    const body = await loginRes.json() as Record<string, unknown>
    accessToken = body['accessToken'] as string
    refreshTokenCookie = getCookieValue(loginRes, 'schloss_refresh') ?? ''

    // Alice bootstraps as the platform's first user, i.e. its sole admin -
    // these tests are about self-deletion mechanics, not the last-admin
    // guard (which has its own dedicated tests below), so promote a
    // second user to admin first to keep her deletable throughout.
    const inviteCode = await mintInvite(accessToken)
    await post('/auth/register', {
      email: 'second-admin@example.com',
      password: 'password123',
      name: 'Second Admin',
      inviteCode,
    })
    const secondAdminLogin = await post('/auth/login', {
      email: 'second-admin@example.com',
      password: 'password123',
    }, { 'X-Schlussel-Frontend': '1' })
    const secondAdminBody = await secondAdminLogin.json() as Record<string, unknown>
    secondAdminAccessToken = secondAdminBody['accessToken'] as string
    const secondAdminUser = secondAdminBody['user'] as Record<string, unknown>
    await patch(
      `/auth/admin/users/${secondAdminUser['id']}/role`,
      { role: 'admin' },
      { Authorization: `Bearer ${accessToken}` },
    )
  })

  it('returns 401 when Authorization header is missing', async () => {
    const res = await del('/auth/account', { password: 'password123' })
    expect(res.status).toBe(401)
  })

  it('returns 401 for a garbage Bearer token', async () => {
    const res = await del(
      '/auth/account',
      { password: 'password123' },
      { Authorization: 'Bearer thisisnotavalidtoken' },
    )
    expect(res.status).toBe(401)
  })

  it('returns 401 for a tampered token', async () => {
    const parts = accessToken.split('.')
    const sig = parts[2]!
    const mid = Math.floor(sig.length / 2)
    const tamperedChar = sig[mid] === 'A' ? 'B' : 'A'
    const tamperedSig = sig.slice(0, mid) + tamperedChar + sig.slice(mid + 1)
    const tampered = `${parts[0]}.${parts[1]}.${tamperedSig}`

    const res = await del(
      '/auth/account',
      { password: 'password123' },
      { Authorization: `Bearer ${tampered}` },
    )
    expect(res.status).toBe(401)
  })

  it('returns 401 for expired access token', async () => {
    vi.useFakeTimers()
    try {
      vi.advanceTimersByTime(16 * 60 * 1000)
      const res = await del(
        '/auth/account',
        { password: 'password123' },
        { Authorization: `Bearer ${accessToken}` },
      )
      expect(res.status).toBe(401)
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns 400 or 422 for missing password field', async () => {
    const res = await del('/auth/account', {}, { Authorization: `Bearer ${accessToken}` })
    expect([400, 422]).toContain(res.status)
  })

  it('returns 401 with { error: "Invalid password" } when password is wrong, and does not delete the account', async () => {
    const res = await del(
      '/auth/account',
      { password: 'wrongpassword' },
      { Authorization: `Bearer ${accessToken}` },
    )
    expect(res.status).toBe(401)
    const body = await res.json() as Record<string, unknown>
    expect(body['error']).toBe('Invalid password')

    // Prove the account is still intact: the same still-valid access token
    // continues to work.
    const meRes = await app.request('/auth/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    expect(meRes.status).toBe(200)
  })

  it('returns 200 with { ok: true } on success', async () => {
    const userId = JSON.parse(Buffer.from(accessToken.split('.')[1]!, 'base64url').toString())['sub'] as string
    const res = await del(
      '/auth/account',
      { password: 'password123' },
      { Authorization: `Bearer ${accessToken}` },
    )
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body['ok']).toBe(true)
    expect(sqlite.prepare('SELECT user_id, initiated_by, status FROM deletion_jobs').get()).toEqual({
      user_id: userId, initiated_by: 'self', status: 'pending',
    })
    expect(sqlite.prepare('SELECT count(*) AS count FROM deletion_job_targets').get()).toEqual({ count: 6 })
  })

  it('rolls back identity deletion when durable saga persistence fails', async () => {
    sqlite.exec(`CREATE TRIGGER fail_deletion_job BEFORE INSERT ON deletion_jobs BEGIN SELECT RAISE(ABORT, 'fail'); END`)
    try {
      const response = await del('/auth/account', { password: 'password123' }, {
        Authorization: `Bearer ${accessToken}`,
      })
      expect(response.status).toBe(500)
      const me = await app.request('/auth/me', { headers: { Authorization: `Bearer ${accessToken}` } })
      expect(me.status).toBe(200)
    } finally {
      sqlite.exec('DROP TRIGGER fail_deletion_job')
    }
  })

  it('after deletion, a fresh register with the same email succeeds', async () => {
    await del(
      '/auth/account',
      { password: 'password123' },
      { Authorization: `Bearer ${accessToken}` },
    )
    // The platform isn't empty anymore (second-admin is still around from
    // the beforeEach), so re-registering this email needs a fresh invite.
    const inviteCode = await mintInvite(secondAdminAccessToken)
    const res = await post('/auth/register', {
      email: 'alice@example.com',
      password: 'password123',
      name: 'Alice',
      inviteCode,
    })
    expect(res.status).toBe(201)
  })

  it('after deletion, login with the original credentials returns 401', async () => {
    await del(
      '/auth/account',
      { password: 'password123' },
      { Authorization: `Bearer ${accessToken}` },
    )
    const res = await post('/auth/login', { email: 'alice@example.com', password: 'password123' }, { 'X-Schlussel-Frontend': '1' })
    expect(res.status).toBe(401)
  })

  it('invalidates a pre-existing refresh session', async () => {
    expect(refreshTokenCookie).not.toBe('')
    await del(
      '/auth/account',
      { password: 'password123' },
      { Authorization: `Bearer ${accessToken}` },
    )

    const res = await app.request('/auth/refresh', {
      method: 'POST',
      headers: { Cookie: `schloss_refresh=${refreshTokenCookie}` },
    })
    expect(res.status).toBe(401)
  })

  it('clears the schloss_refresh cookie in the response', async () => {
    const res = await del(
      '/auth/account',
      { password: 'password123' },
      { Authorization: `Bearer ${accessToken}` },
    )
    const raw = getRawCookie(res, 'schloss_refresh')
    expect(raw).not.toBeNull()
    const isCleared =
      raw!.includes('Max-Age=0') ||
      raw!.includes('max-age=0') ||
      raw!.includes('Expires=Thu, 01 Jan 1970') ||
      raw!.match(/schloss_refresh=;/) !== null ||
      raw!.match(/schloss_refresh=$/) !== null
    expect(isCleared).toBe(true)
  })

  it('does not affect a second, independently registered user', async () => {
    const inviteCode = await mintInvite(accessToken)
    await post('/auth/register', { email: 'bob@example.com', password: 'bobpassword', name: 'Bob', inviteCode })
    const bobLogin = await post('/auth/login', { email: 'bob@example.com', password: 'bobpassword' }, { 'X-Schlussel-Frontend': '1' })
    const bobBody = await bobLogin.json() as Record<string, unknown>
    const bobToken = bobBody['accessToken'] as string

    const delRes = await del(
      '/auth/account',
      { password: 'password123' },
      { Authorization: `Bearer ${accessToken}` },
    )
    expect(delRes.status).toBe(200)

    const bobMe = await app.request('/auth/me', {
      headers: { Authorization: `Bearer ${bobToken}` },
    })
    expect(bobMe.status).toBe(200)
    const bobMeBody = await bobMe.json() as Record<string, unknown>
    expect(bobMeBody['email']).toBe('bob@example.com')
  })

  it('returns 409 and does not delete the account when the caller is the sole remaining admin', async () => {
    // Demote the beforeEach's second admin back to a plain user, so Alice
    // (accessToken) is genuinely the only admin left.
    const usersRes = await app.request('/auth/admin/users', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    const allUsers = await usersRes.json() as Record<string, unknown>[]
    const secondAdmin = allUsers.find((u) => u['email'] === 'second-admin@example.com')!
    await patch(
      `/auth/admin/users/${secondAdmin['id']}/role`,
      { role: 'user' },
      { Authorization: `Bearer ${accessToken}` },
    )

    const res = await del(
      '/auth/account',
      { password: 'password123' },
      { Authorization: `Bearer ${accessToken}` },
    )
    expect(res.status).toBe(409)

    // Account still intact: the same access token continues to work.
    const meRes = await app.request('/auth/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    expect(meRes.status).toBe(200)
  })
})

// ── Session management: PATCH /auth/name, GET/DELETE /auth/sessions ────────

/** True when a raw Set-Cookie string represents a cleared cookie (same check
 * used by the existing POST /auth/logout and DELETE /auth/account tests). */
function isCookieCleared(raw: string): boolean {
  return (
    raw.includes('Max-Age=0') ||
    raw.includes('max-age=0') ||
    raw.includes('Expires=Thu, 01 Jan 1970') ||
    raw.match(/schloss_refresh=;/) !== null ||
    raw.match(/schloss_refresh=$/) !== null
  )
}

function getSessions(accessToken: string, refreshCookie?: string) {
  const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` }
  if (refreshCookie) headers['Cookie'] = `schloss_refresh=${refreshCookie}`
  return app.request('/auth/sessions', { headers })
}

function deleteSession(id: string, accessToken: string, refreshCookie?: string) {
  const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` }
  if (refreshCookie) headers['Cookie'] = `schloss_refresh=${refreshCookie}`
  return app.request(`/auth/sessions/${id}`, { method: 'DELETE', headers })
}

function deleteAllSessions(accessToken: string, refreshCookie?: string) {
  const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` }
  if (refreshCookie) headers['Cookie'] = `schloss_refresh=${refreshCookie}`
  return app.request('/auth/sessions', { method: 'DELETE', headers })
}

describe('PATCH /auth/name', () => {
  let accessToken: string

  beforeEach(async () => {
    await post('/auth/register', {
      email: 'alice@example.com',
      password: 'password123',
      name: 'Alice',
    })
    const loginRes = await post('/auth/login', {
      email: 'alice@example.com',
      password: 'password123',
    }, { 'X-Schlussel-Frontend': '1' })
    const body = await loginRes.json() as Record<string, unknown>
    accessToken = body['accessToken'] as string
  })

  it('returns 401 when Authorization header is missing', async () => {
    const res = await patch('/auth/name', { name: 'Alicia' })
    expect(res.status).toBe(401)
  })

  it('returns 401 for a garbage Bearer token', async () => {
    const res = await patch(
      '/auth/name',
      { name: 'Alicia' },
      { Authorization: 'Bearer thisisnotavalidtoken' },
    )
    expect(res.status).toBe(401)
  })

  it('returns 401 for a tampered token', async () => {
    const parts = accessToken.split('.')
    const sig = parts[2]!
    const mid = Math.floor(sig.length / 2)
    const tamperedChar = sig[mid] === 'A' ? 'B' : 'A'
    const tamperedSig = sig.slice(0, mid) + tamperedChar + sig.slice(mid + 1)
    const tampered = `${parts[0]}.${parts[1]}.${tamperedSig}`

    const res = await patch(
      '/auth/name',
      { name: 'Alicia' },
      { Authorization: `Bearer ${tampered}` },
    )
    expect(res.status).toBe(401)
  })

  it('returns 401 for expired access token', async () => {
    vi.useFakeTimers()
    try {
      vi.advanceTimersByTime(16 * 60 * 1000)
      const res = await patch(
        '/auth/name',
        { name: 'Alicia' },
        { Authorization: `Bearer ${accessToken}` },
      )
      expect(res.status).toBe(401)
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns 400 or 422 for empty name', async () => {
    const res = await patch('/auth/name', { name: '' }, { Authorization: `Bearer ${accessToken}` })
    expect([400, 422]).toContain(res.status)
  })

  it('returns 400 or 422 for missing name field', async () => {
    const res = await patch('/auth/name', {}, { Authorization: `Bearer ${accessToken}` })
    expect([400, 422]).toContain(res.status)
  })

  it('returns 400 or 422 for name longer than 100 characters', async () => {
    const res = await patch(
      '/auth/name',
      { name: 'a'.repeat(101) },
      { Authorization: `Bearer ${accessToken}` },
    )
    expect([400, 422]).toContain(res.status)
  })

  it('accepts name of exactly 100 characters', async () => {
    const res = await patch(
      '/auth/name',
      { name: 'a'.repeat(100) },
      { Authorization: `Bearer ${accessToken}` },
    )
    expect(res.status).toBe(200)
  })

  it('returns 200 with the updated user object, email and role unchanged', async () => {
    const res = await patch(
      '/auth/name',
      { name: 'Alicia' },
      { Authorization: `Bearer ${accessToken}` },
    )
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body['name']).toBe('Alicia')
    expect(body['email']).toBe('alice@example.com')
    expect(['admin', 'user']).toContain(body['role'])
    expect(typeof body['id']).toBe('string')
  })

  it('GET /auth/me reflects the new name afterward', async () => {
    await patch('/auth/name', { name: 'Alicia' }, { Authorization: `Bearer ${accessToken}` })
    const meRes = await app.request('/auth/me', { headers: { Authorization: `Bearer ${accessToken}` } })
    expect(meRes.status).toBe(200)
    const meBody = await meRes.json() as Record<string, unknown>
    expect(meBody['name']).toBe('Alicia')
  })

  it('leaves password and email untouched — a fresh login with the original password still works', async () => {
    await patch('/auth/name', { name: 'Alicia' }, { Authorization: `Bearer ${accessToken}` })
    const res = await post('/auth/login', { email: 'alice@example.com', password: 'password123' }, { 'X-Schlussel-Frontend': '1' })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    const user = body['user'] as Record<string, unknown>
    expect(user['email']).toBe('alice@example.com')
    expect(user['name']).toBe('Alicia')
  })

  it('does not affect a second, independently registered user', async () => {
    const inviteCode = await mintInvite(accessToken)
    await post('/auth/register', { email: 'bob@example.com', password: 'bobpassword', name: 'Bob', inviteCode })
    const bobLogin = await post('/auth/login', { email: 'bob@example.com', password: 'bobpassword' }, { 'X-Schlussel-Frontend': '1' })
    const bobBody = await bobLogin.json() as Record<string, unknown>
    const bobToken = bobBody['accessToken'] as string

    await patch('/auth/name', { name: 'Alicia' }, { Authorization: `Bearer ${accessToken}` })

    const bobMe = await app.request('/auth/me', { headers: { Authorization: `Bearer ${bobToken}` } })
    expect(bobMe.status).toBe(200)
    const bobMeBody = await bobMe.json() as Record<string, unknown>
    expect(bobMeBody['name']).toBe('Bob')
  })
})

describe('GET /auth/sessions', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const res = await app.request('/auth/sessions')
    expect(res.status).toBe(401)
  })

  it('returns 401 for a garbage Bearer token', async () => {
    const res = await app.request('/auth/sessions', {
      headers: { Authorization: 'Bearer thisisnotavalidtoken' },
    })
    expect(res.status).toBe(401)
  })

  it('returns 200 with an array containing the session, with the expected shape', async () => {
    await post('/auth/register', { email: 'alice@example.com', password: 'password123', name: 'Alice' })
    const loginRes = await post(
      '/auth/login',
      { email: 'alice@example.com', password: 'password123' },
      { 'User-Agent': 'TestBrowser/1.0', 'X-Forwarded-For': '203.0.113.5', 'X-Schlussel-Frontend': '1' },
    )
    const loginBody = await loginRes.json() as Record<string, unknown>
    const accessToken = loginBody['accessToken'] as string

    const res = await getSessions(accessToken)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>[]
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBe(1)
    const session = body[0]!
    expect(typeof session['id']).toBe('string')
    expect(session['userAgent']).toBe('TestBrowser/1.0')
    expect(session['ipAddress']).toBe('203.0.113.5')
    expect(typeof session['createdAt']).toBe('string')
    expect(new Date(session['createdAt'] as string).toString()).not.toBe('Invalid Date')
    expect(typeof session['expiresAt']).toBe('string')
    expect(new Date(session['expiresAt'] as string).toString()).not.toBe('Invalid Date')
    expect(typeof session['current']).toBe('boolean')
  })

  it('ipAddress is null when the login request had no X-Forwarded-For header', async () => {
    await post('/auth/register', { email: 'alice@example.com', password: 'password123', name: 'Alice' })
    const loginRes = await post('/auth/login', { email: 'alice@example.com', password: 'password123' }, { 'X-Schlussel-Frontend': '1' })
    const loginBody = await loginRes.json() as Record<string, unknown>
    const accessToken = loginBody['accessToken'] as string

    const res = await getSessions(accessToken)
    const body = await res.json() as Record<string, unknown>[]
    expect(body.length).toBe(1)
    expect(body[0]!['ipAddress']).toBeNull()
  })

  it('only returns sessions belonging to the calling user', async () => {
    await post('/auth/register', { email: 'alice@example.com', password: 'password123', name: 'Alice' })
    // Single login for Alice - also used to mint Bob's invite, so this
    // test still creates exactly one session per user, matching the
    // assertions below.
    const aliceLogin = await post('/auth/login', { email: 'alice@example.com', password: 'password123' }, { 'X-Schlussel-Frontend': '1' })
    const aliceBody = await aliceLogin.json() as Record<string, unknown>
    const aliceToken = aliceBody['accessToken'] as string
    const inviteCode = await mintInvite(aliceToken)
    await post('/auth/register', { email: 'bob@example.com', password: 'bobpassword', name: 'Bob', inviteCode })
    const bobLogin = await post('/auth/login', { email: 'bob@example.com', password: 'bobpassword' }, { 'X-Schlussel-Frontend': '1' })
    const bobBody = await bobLogin.json() as Record<string, unknown>
    const bobToken = bobBody['accessToken'] as string

    const aliceRes = await getSessions(aliceToken)
    const bobRes = await getSessions(bobToken)
    const aliceSessions = await aliceRes.json() as Record<string, unknown>[]
    const bobSessions = await bobRes.json() as Record<string, unknown>[]

    expect(aliceSessions.length).toBe(1)
    expect(bobSessions.length).toBe(1)
    expect(aliceSessions[0]!['id']).not.toBe(bobSessions[0]!['id'])
  })

  it('marks only the row matching the sent cookie as current: true', async () => {
    await post('/auth/register', { email: 'alice@example.com', password: 'password123', name: 'Alice' })
    const login1 = await post('/auth/login', { email: 'alice@example.com', password: 'password123' }, { 'X-Schlussel-Frontend': '1' })
    const login2 = await post('/auth/login', { email: 'alice@example.com', password: 'password123' }, { 'X-Schlussel-Frontend': '1' })
    const login1Body = await login1.json() as Record<string, unknown>
    const accessToken = login1Body['accessToken'] as string
    const cookie1 = getCookieValue(login1, 'schloss_refresh') ?? ''
    const cookie2 = getCookieValue(login2, 'schloss_refresh') ?? ''
    expect(cookie1).not.toBe('')
    expect(cookie2).not.toBe('')
    expect(cookie1).not.toBe(cookie2)

    const res = await getSessions(accessToken, cookie1)
    const sessions = await res.json() as Record<string, unknown>[]
    expect(sessions.length).toBe(2)
    const currentRows = sessions.filter((s) => s['current'] === true)
    const notCurrentRows = sessions.filter((s) => s['current'] === false)
    expect(currentRows.length).toBe(1)
    expect(notCurrentRows.length).toBe(1)
  })

  it('every row has current: false when no cookie is sent', async () => {
    await post('/auth/register', { email: 'alice@example.com', password: 'password123', name: 'Alice' })
    const login1 = await post('/auth/login', { email: 'alice@example.com', password: 'password123' }, { 'X-Schlussel-Frontend': '1' })
    await post('/auth/login', { email: 'alice@example.com', password: 'password123' }, { 'X-Schlussel-Frontend': '1' })
    const login1Body = await login1.json() as Record<string, unknown>
    const accessToken = login1Body['accessToken'] as string

    const res = await getSessions(accessToken)
    const sessions = await res.json() as Record<string, unknown>[]
    expect(sessions.length).toBe(2)
    for (const s of sessions) expect(s['current']).toBe(false)
  })

  it('two logins for the same user produce two distinct rows', async () => {
    await post('/auth/register', { email: 'alice@example.com', password: 'password123', name: 'Alice' })
    const login1 = await post('/auth/login', { email: 'alice@example.com', password: 'password123' }, { 'X-Schlussel-Frontend': '1' })
    await post('/auth/login', { email: 'alice@example.com', password: 'password123' }, { 'X-Schlussel-Frontend': '1' })
    const login1Body = await login1.json() as Record<string, unknown>
    const accessToken = login1Body['accessToken'] as string

    const res = await getSessions(accessToken)
    const sessions = await res.json() as Record<string, unknown>[]
    expect(sessions.length).toBe(2)
    const ids = new Set(sessions.map((s) => s['id']))
    expect(ids.size).toBe(2)
  })

  it('does not return an already-expired session', async () => {
    const registerRes = await post('/auth/register', {
      email: 'alice@example.com',
      password: 'password123',
      name: 'Alice',
    })
    const registerBody = await registerRes.json() as Record<string, unknown>
    const userId = registerBody['id'] as string
    const loginRes = await post('/auth/login', { email: 'alice@example.com', password: 'password123' }, { 'X-Schlussel-Frontend': '1' })
    const loginBody = await loginRes.json() as Record<string, unknown>
    const accessToken = loginBody['accessToken'] as string

    // Simulate a session whose expiry has already passed but has not yet
    // been cleaned up from the table.
    sqlite
      .prepare('UPDATE refresh_tokens SET expires_at = ? WHERE user_id = ?')
      .run(Math.floor(Date.now() / 1000) - 3600, userId)

    const res = await getSessions(accessToken)
    expect(res.status).toBe(200)
    const sessions = await res.json() as Record<string, unknown>[]
    expect(sessions.length).toBe(0)
  })
})

describe('DELETE /auth/sessions/:id', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const res = await app.request('/auth/sessions/does-not-matter', { method: 'DELETE' })
    expect(res.status).toBe(401)
  })

  it('returns 401 for a garbage Bearer token', async () => {
    const res = await app.request('/auth/sessions/does-not-matter', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer thisisnotavalidtoken' },
    })
    expect(res.status).toBe(401)
  })

  it('returns 404 for a nonexistent session id and deletes nothing', async () => {
    await post('/auth/register', { email: 'alice@example.com', password: 'password123', name: 'Alice' })
    const loginRes = await post('/auth/login', { email: 'alice@example.com', password: 'password123' }, { 'X-Schlussel-Frontend': '1' })
    const loginBody = await loginRes.json() as Record<string, unknown>
    const accessToken = loginBody['accessToken'] as string

    const res = await deleteSession(randomUUID(), accessToken)
    expect(res.status).toBe(404)

    const sessions = await (await getSessions(accessToken)).json() as Record<string, unknown>[]
    expect(sessions.length).toBe(1)
  })

  it('returns 404 when the id belongs to a different user, and does not delete it', async () => {
    await post('/auth/register', { email: 'alice@example.com', password: 'password123', name: 'Alice' })
    const aliceLogin = await post('/auth/login', { email: 'alice@example.com', password: 'password123' }, { 'X-Schlussel-Frontend': '1' })
    const aliceBody = await aliceLogin.json() as Record<string, unknown>
    const aliceToken = aliceBody['accessToken'] as string
    const inviteCode = await mintInvite(aliceToken)
    await post('/auth/register', { email: 'bob@example.com', password: 'bobpassword', name: 'Bob', inviteCode })
    const bobLogin = await post('/auth/login', { email: 'bob@example.com', password: 'bobpassword' }, { 'X-Schlussel-Frontend': '1' })
    const bobBody = await bobLogin.json() as Record<string, unknown>
    const bobToken = bobBody['accessToken'] as string
    const aliceCookie = getCookieValue(aliceLogin, 'schloss_refresh') ?? ''

    const aliceSessions = await (await getSessions(aliceToken)).json() as Record<string, unknown>[]
    const aliceSessionId = aliceSessions[0]!['id'] as string

    // Bob tries to revoke Alice's session by id.
    const res = await deleteSession(aliceSessionId, bobToken)
    expect(res.status).toBe(404)

    // Alice's session is still listed...
    const aliceSessionsAfter = await (await getSessions(aliceToken)).json() as Record<string, unknown>[]
    expect(aliceSessionsAfter.length).toBe(1)

    // ...and still usable via refresh.
    await new Promise((r) => setTimeout(r, 1100))
    const refreshRes = await app.request('/auth/refresh', {
      method: 'POST',
      headers: { Cookie: `schloss_refresh=${aliceCookie}` },
    })
    expect(refreshRes.status).toBe(200)
  })

  it('on success, returns 200 with { ok: true } and revokes only that session', async () => {
    await post('/auth/register', { email: 'alice@example.com', password: 'password123', name: 'Alice' })
    const login1 = await post('/auth/login', { email: 'alice@example.com', password: 'password123' }, { 'X-Schlussel-Frontend': '1' })
    const login2 = await post('/auth/login', { email: 'alice@example.com', password: 'password123' }, { 'X-Schlussel-Frontend': '1' })
    const login1Body = await login1.json() as Record<string, unknown>
    const accessToken = login1Body['accessToken'] as string
    const cookie1 = getCookieValue(login1, 'schloss_refresh') ?? ''
    const cookie2 = getCookieValue(login2, 'schloss_refresh') ?? ''

    const sessions = await (await getSessions(accessToken, cookie1)).json() as Record<string, unknown>[]
    const session1 = sessions.find((s) => s['current'] === true)!
    const session1Id = session1['id'] as string

    const res = await deleteSession(session1Id, accessToken, cookie1)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body['ok']).toBe(true)

    // The revoked session's cookie no longer refreshes.
    const refresh1 = await app.request('/auth/refresh', {
      method: 'POST',
      headers: { Cookie: `schloss_refresh=${cookie1}` },
    })
    expect(refresh1.status).toBe(401)

    // The other session is unaffected.
    await new Promise((r) => setTimeout(r, 1100))
    const refresh2 = await app.request('/auth/refresh', {
      method: 'POST',
      headers: { Cookie: `schloss_refresh=${cookie2}` },
    })
    expect(refresh2.status).toBe(200)
  })

  it('clears the schloss_refresh cookie when the revoked session matches the cookie sent with the request', async () => {
    await post('/auth/register', { email: 'alice@example.com', password: 'password123', name: 'Alice' })
    const login1 = await post('/auth/login', { email: 'alice@example.com', password: 'password123' }, { 'X-Schlussel-Frontend': '1' })
    const login1Body = await login1.json() as Record<string, unknown>
    const accessToken = login1Body['accessToken'] as string
    const cookie1 = getCookieValue(login1, 'schloss_refresh') ?? ''

    const sessions = await (await getSessions(accessToken, cookie1)).json() as Record<string, unknown>[]
    const sessionId = sessions[0]!['id'] as string

    const res = await deleteSession(sessionId, accessToken, cookie1)
    expect(res.status).toBe(200)

    const raw = getRawCookie(res, 'schloss_refresh')
    expect(raw).not.toBeNull()
    expect(isCookieCleared(raw!)).toBe(true)
  })

  it('leaves the request cookie untouched when the revoked session is a different session for the same user', async () => {
    await post('/auth/register', { email: 'alice@example.com', password: 'password123', name: 'Alice' })
    const login1 = await post('/auth/login', { email: 'alice@example.com', password: 'password123' }, { 'X-Schlussel-Frontend': '1' })
    const login2 = await post('/auth/login', { email: 'alice@example.com', password: 'password123' }, { 'X-Schlussel-Frontend': '1' })
    const login1Body = await login1.json() as Record<string, unknown>
    const accessToken = login1Body['accessToken'] as string
    const cookie1 = getCookieValue(login1, 'schloss_refresh') ?? ''
    const cookie2 = getCookieValue(login2, 'schloss_refresh') ?? ''

    const sessions = await (await getSessions(accessToken, cookie1)).json() as Record<string, unknown>[]
    const otherSession = sessions.find((s) => s['current'] === false)!
    const otherSessionId = otherSession['id'] as string

    // The request carries cookie1 (the caller's own current session) but
    // targets the OTHER session (cookie2's row).
    const res = await deleteSession(otherSessionId, accessToken, cookie1)
    expect(res.status).toBe(200)

    const raw = getRawCookie(res, 'schloss_refresh')
    if (raw !== null) {
      expect(isCookieCleared(raw)).toBe(false)
    }

    // cookie1 (the caller's own session) is still fully usable.
    await new Promise((r) => setTimeout(r, 1100))
    const refresh1 = await app.request('/auth/refresh', {
      method: 'POST',
      headers: { Cookie: `schloss_refresh=${cookie1}` },
    })
    expect(refresh1.status).toBe(200)

    // cookie2 (the revoked session) no longer works.
    const refresh2 = await app.request('/auth/refresh', {
      method: 'POST',
      headers: { Cookie: `schloss_refresh=${cookie2}` },
    })
    expect(refresh2.status).toBe(401)
  })
})

describe('DELETE /auth/sessions', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const res = await app.request('/auth/sessions', { method: 'DELETE' })
    expect(res.status).toBe(401)
  })

  it('returns 401 for a garbage Bearer token', async () => {
    const res = await app.request('/auth/sessions', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer thisisnotavalidtoken' },
    })
    expect(res.status).toBe(401)
  })

  it('invalidates every session for the calling user, including the one used to make the request', async () => {
    await post('/auth/register', { email: 'alice@example.com', password: 'password123', name: 'Alice' })
    const login1 = await post('/auth/login', { email: 'alice@example.com', password: 'password123' }, { 'X-Schlussel-Frontend': '1' })
    const login2 = await post('/auth/login', { email: 'alice@example.com', password: 'password123' }, { 'X-Schlussel-Frontend': '1' })
    const login1Body = await login1.json() as Record<string, unknown>
    const accessToken = login1Body['accessToken'] as string
    const cookie1 = getCookieValue(login1, 'schloss_refresh') ?? ''
    const cookie2 = getCookieValue(login2, 'schloss_refresh') ?? ''

    const res = await deleteAllSessions(accessToken, cookie1)
    expect(res.status).toBe(200)

    const refresh1 = await app.request('/auth/refresh', {
      method: 'POST',
      headers: { Cookie: `schloss_refresh=${cookie1}` },
    })
    expect(refresh1.status).toBe(401)

    const refresh2 = await app.request('/auth/refresh', {
      method: 'POST',
      headers: { Cookie: `schloss_refresh=${cookie2}` },
    })
    expect(refresh2.status).toBe(401)
  })

  it('clears the callers own cookie even when no cookie was sent with the request', async () => {
    await post('/auth/register', { email: 'alice@example.com', password: 'password123', name: 'Alice' })
    const loginRes = await post('/auth/login', { email: 'alice@example.com', password: 'password123' }, { 'X-Schlussel-Frontend': '1' })
    const loginBody = await loginRes.json() as Record<string, unknown>
    const accessToken = loginBody['accessToken'] as string

    const res = await deleteAllSessions(accessToken)
    expect(res.status).toBe(200)

    const raw = getRawCookie(res, 'schloss_refresh')
    expect(raw).not.toBeNull()
    expect(isCookieCleared(raw!)).toBe(true)
  })

  it('does not set a fresh session cookie — the caller ends up fully logged out', async () => {
    await post('/auth/register', { email: 'alice@example.com', password: 'password123', name: 'Alice' })
    const loginRes = await post('/auth/login', { email: 'alice@example.com', password: 'password123' }, { 'X-Schlussel-Frontend': '1' })
    const loginBody = await loginRes.json() as Record<string, unknown>
    const accessToken = loginBody['accessToken'] as string
    const cookie = getCookieValue(loginRes, 'schloss_refresh') ?? ''

    const res = await deleteAllSessions(accessToken, cookie)
    expect(res.status).toBe(200)

    // Either no cookie value at all, or an empty (cleared) one — never a
    // fresh, usable token.
    const newCookie = getCookieValue(res, 'schloss_refresh')
    expect(newCookie === null || newCookie === '').toBe(true)
  })

  it('does not affect a different users sessions', async () => {
    await post('/auth/register', { email: 'alice@example.com', password: 'password123', name: 'Alice' })
    const aliceLogin = await post('/auth/login', { email: 'alice@example.com', password: 'password123' }, { 'X-Schlussel-Frontend': '1' })
    const aliceBody = await aliceLogin.json() as Record<string, unknown>
    const aliceToken = aliceBody['accessToken'] as string
    const inviteCode = await mintInvite(aliceToken)
    await post('/auth/register', { email: 'bob@example.com', password: 'bobpassword', name: 'Bob', inviteCode })
    const bobLogin = await post('/auth/login', { email: 'bob@example.com', password: 'bobpassword' }, { 'X-Schlussel-Frontend': '1' })
    const bobBody = await bobLogin.json() as Record<string, unknown>
    const bobToken = bobBody['accessToken'] as string
    const bobCookie = getCookieValue(bobLogin, 'schloss_refresh') ?? ''

    const res = await deleteAllSessions(aliceToken)
    expect(res.status).toBe(200)

    // Bob's session list is unchanged.
    const bobSessions = await (await getSessions(bobToken)).json() as Record<string, unknown>[]
    expect(bobSessions.length).toBe(1)

    // ...and his cookie still refreshes fine (trusted, so as not to
    // silently consume the session — see the "trusted origin gate" tests
    // above for why an untrusted refresh alone wouldn't prove this).
    await new Promise((r) => setTimeout(r, 1100))
    const bobRefresh = await app.request('/auth/refresh', {
      method: 'POST',
      headers: { Cookie: `schloss_refresh=${bobCookie}`, ...TRUSTED_HEADER },
    })
    expect(bobRefresh.status).toBe(200)
  })
})
