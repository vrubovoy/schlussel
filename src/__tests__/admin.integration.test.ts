/**
 * Integration tests for admin user/invite management endpoints
 * (POST/GET/DELETE /auth/invites, GET /auth/admin/users,
 * PATCH /auth/admin/users/:id/role, DELETE /auth/admin/users/:id/sessions,
 * DELETE /auth/admin/users/:id, GET /auth/admin/stats).
 *
 * Isolation strategy mirrors auth.integration.test.ts:
 *   - process.env is mutated at the very top of this module (before any imports
 *     that might read it at load time).
 *   - All project code is loaded via dynamic imports inside beforeAll, so the
 *     env values set here are what the modules actually see.
 *   - A fresh temp SQLite file is used exclusively by this test file.
 *   - Tables are wiped in beforeEach so every test starts with a clean slate.
 *
 * Written strictly from the API spec, without reading routes/auth.ts or
 * routes/admin.ts.
 *
 * Note: since registering additional users via POST /auth/register with an
 * inviteCode is exercised (and independently tested) in
 * invites.integration.test.ts, and is verified there to actually be broken
 * (see that file / the final report), test SETUP in this file that merely
 * needs "some second/third user account to exist" seeds users directly into
 * the `users` table via drizzle (hashing the password with the project's
 * own `hashPassword` utility from utils/password.ts, a plain hashing helper,
 * not route/business logic) rather than going through the broken endpoint.
 * Tests that are actually ABOUT the register+inviteCode round trip still go
 * through the real API and are expected to surface that bug here too.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'crypto'
import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import type { Hono } from 'hono'
import type { users as UsersTable } from '../db/schema.js'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

// ── Isolated environment ────────────────────────────────────────────────────
const testId = randomUUID().slice(0, 8)
const DB_PATH = join(tmpdir(), `schlussel-test-admin-${testId}.db`)
const KEYS_DIR = join(tmpdir(), `schlussel-keys-admin-${testId}`)
const MIGRATIONS_DIR = fileURLToPath(new URL('../db/migrations', import.meta.url))

process.env['DATABASE_PATH'] = DB_PATH
process.env['KEYS_DIR'] = KEYS_DIR
process.env['JWT_ISSUER'] = 'schlussel'

// ── Module handles populated in beforeAll ───────────────────────────────────
let app: Hono
let sqlite: import('better-sqlite3').Database
let db: BetterSQLite3Database<Record<string, unknown>>
let users: typeof UsersTable
let hashPassword: (password: string) => Promise<string>

// ── Setup / teardown ────────────────────────────────────────────────────────
beforeAll(async () => {
  mkdirSync(KEYS_DIR, { recursive: true })

  const [keysModule, authModule, adminModule, dbModule, schemaModule, passwordModule, migratorModule, honoModule] =
    await Promise.all([
      import('../utils/keys.js'),
      import('../routes/auth.js'),
      import('../routes/admin.js'),
      import('../db/index.js'),
      import('../db/schema.js'),
      import('../utils/password.js'),
      import('drizzle-orm/better-sqlite3/migrator'),
      import('hono'),
    ])

  const { initKeys, getJwks } = keysModule
  const { authRouter } = authModule
  const { adminRouter } = adminModule
  const { db: dbInstance, sqlite: sqliteInstance } = dbModule
  const { migrate } = migratorModule
  const { Hono } = honoModule

  sqlite = sqliteInstance
  db = dbInstance
  users = schemaModule.users
  hashPassword = passwordModule.hashPassword

  await initKeys()
  migrate(db, { migrationsFolder: MIGRATIONS_DIR })

  const testApp = new Hono()
  testApp.get('/.well-known/jwks.json', (c) => c.json(getJwks()))
  testApp.get('/health', (c) => c.json({ status: 'ok' }))
  testApp.route('/auth', authRouter)
  testApp.route('/auth', adminRouter)

  app = testApp
})

beforeEach(() => {
  // Delete child rows first to satisfy FK, then parent.
  sqlite.exec('DELETE FROM deletion_job_targets')
  sqlite.exec('DELETE FROM deletion_jobs')
  sqlite.exec('DELETE FROM refresh_tokens')
  sqlite.exec('DELETE FROM invites')
  sqlite.exec('DELETE FROM users')
})

afterAll(() => {
  try { sqlite?.close() } catch { /* ignore */ }
  try { rmSync(DB_PATH) } catch { /* ignore */ }
  try { rmSync(KEYS_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
})

// ── Helpers ──────────────────────────────────────────────────────────────────
const JSON_HEADERS = { 'Content-Type': 'application/json' }
const DEFAULT_PASSWORD = 'password123'

function post(path: string, body: unknown, extraHeaders?: Record<string, string>) {
  return app.request(path, {
    method: 'POST',
    headers: { ...JSON_HEADERS, ...extraHeaders },
    body: JSON.stringify(body),
  })
}

function get(path: string, extraHeaders?: Record<string, string>) {
  return app.request(path, {
    method: 'GET',
    headers: { ...extraHeaders },
  })
}

function patchReq(path: string, body: unknown, extraHeaders?: Record<string, string>) {
  return app.request(path, {
    method: 'PATCH',
    headers: { ...JSON_HEADERS, ...extraHeaders },
    body: JSON.stringify(body),
  })
}

function del(path: string, body?: unknown, extraHeaders?: Record<string, string>) {
  return app.request(path, {
    method: 'DELETE',
    headers: { ...JSON_HEADERS, ...extraHeaders },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
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

/** Registers the very first (bootstrap admin) user via the real API — no invite required. */
async function registerBootstrapAdmin(email = 'bootstrap-admin@example.com', name = 'Bootstrap Admin') {
  const res = await post('/auth/register', { email, password: DEFAULT_PASSWORD, name })
  expect(res.status).toBe(201)
  return (await res.json()) as { id: string; email: string; name: string; role: string }
}

/**
 * Seeds a user directly into the DB (bypassing the register endpoint, which
 * requires a working invite code for non-bootstrap users — see the note at
 * the top of this file). Used purely for test SETUP.
 */
async function seedUser(
  email: string,
  role: 'admin' | 'user' = 'user',
  password = DEFAULT_PASSWORD,
  name = 'Seeded User',
) {
  const id = randomUUID()
  await db
    .insert(users)
    .values({
      id,
      email,
      passwordHash: await hashPassword(password),
      name,
      role,
      createdAt: new Date(),
    })
    .run()
  return { id, email, name, role }
}

// Sends the same trust header schlussel-frontend's own Caddyfile adds on its
// /auth/* passthrough - without it, /login now correctly withholds the
// session cookie (see the isTrustedOrigin gate this helper is simulating).
async function login(email: string, password = DEFAULT_PASSWORD) {
  const res = await post('/auth/login', { email, password }, { 'X-Schlussel-Frontend': '1' })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { accessToken: string; user: { id: string; role: string } }
  const refreshCookie = getCookieValue(res, 'schloss_refresh')
  return { res, accessToken: body.accessToken, user: body.user, refreshCookie }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Admin endpoint auth/role gating — GET /auth/admin/users (full 401/403/200 check)', () => {
  it('returns 401 with no bearer token at all', async () => {
    const res = await get('/auth/admin/users')
    expect(res.status).toBe(401)
  })

  it('returns 401 with a garbage bearer token', async () => {
    const res = await get('/auth/admin/users', bearer('this.is.garbage'))
    expect(res.status).toBe(401)
  })

  it('returns 403 for a valid bearer token belonging to a non-admin account', async () => {
    await registerBootstrapAdmin()
    const regular = await seedUser('regular@example.com', 'user')
    const { accessToken } = await login(regular.email)

    const res = await get('/auth/admin/users', bearer(accessToken))
    expect(res.status).toBe(403)
  })

  it('returns 200 for a valid admin bearer token', async () => {
    const admin = await registerBootstrapAdmin()
    const { accessToken } = await login(admin.email)

    const res = await get('/auth/admin/users', bearer(accessToken))
    expect(res.status).toBe(200)
  })
})

describe('Admin endpoint role gating — 403-for-non-admin on every other admin endpoint', () => {
  async function nonAdminToken() {
    await registerBootstrapAdmin()
    const regular = await seedUser('nonadmin@example.com', 'user')
    const { accessToken } = await login(regular.email)
    return accessToken
  }

  it('POST /auth/invites -> 403 for non-admin', async () => {
    const token = await nonAdminToken()
    const res = await post('/auth/invites', {}, bearer(token))
    expect(res.status).toBe(403)
  })

  it('GET /auth/invites -> 403 for non-admin', async () => {
    const token = await nonAdminToken()
    const res = await get('/auth/invites', bearer(token))
    expect(res.status).toBe(403)
  })

  it('DELETE /auth/invites/:id -> 403 for non-admin', async () => {
    const token = await nonAdminToken()
    const res = await del('/auth/invites/some-id', undefined, bearer(token))
    expect(res.status).toBe(403)
  })

  it('PATCH /auth/admin/users/:id/role -> 403 for non-admin', async () => {
    const token = await nonAdminToken()
    const res = await patchReq('/auth/admin/users/some-id/role', { role: 'admin' }, bearer(token))
    expect(res.status).toBe(403)
  })

  it('DELETE /auth/admin/users/:id/sessions -> 403 for non-admin', async () => {
    const token = await nonAdminToken()
    const res = await del('/auth/admin/users/some-id/sessions', undefined, bearer(token))
    expect(res.status).toBe(403)
  })

  it('DELETE /auth/admin/users/:id -> 403 for non-admin', async () => {
    const token = await nonAdminToken()
    const res = await del('/auth/admin/users/some-id', { password: DEFAULT_PASSWORD }, bearer(token))
    expect(res.status).toBe(403)
  })

  it('GET /auth/admin/stats -> 403 for non-admin', async () => {
    const token = await nonAdminToken()
    const res = await get('/auth/admin/stats', bearer(token))
    expect(res.status).toBe(403)
  })
})

describe('POST /auth/invites', () => {
  it('defaults expiresInDays to some positive number of days when omitted', async () => {
    const admin = await registerBootstrapAdmin()
    const { accessToken } = await login(admin.email)

    const res = await post('/auth/invites', {}, bearer(accessToken))
    expect(res.status).toBe(201)
    const body = (await res.json()) as { id: string; code: string; createdAt: string; expiresAt: string }

    expect(typeof body.code).toBe('string')
    expect(body.code.length).toBeGreaterThan(0)

    const createdAt = new Date(body.createdAt)
    const expiresAt = new Date(body.expiresAt)
    expect(Number.isNaN(createdAt.getTime())).toBe(false)
    expect(Number.isNaN(expiresAt.getTime())).toBe(false)
    expect(expiresAt.getTime()).toBeGreaterThan(createdAt.getTime())
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now())
  })

  it('accepts an explicit expiresInDays', async () => {
    const admin = await registerBootstrapAdmin()
    const { accessToken } = await login(admin.email)

    const res = await post('/auth/invites', { expiresInDays: 3 }, bearer(accessToken))
    expect(res.status).toBe(201)
    const body = (await res.json()) as { createdAt: string; expiresAt: string }
    const createdAt = new Date(body.createdAt)
    const expiresAt = new Date(body.expiresAt)
    expect(expiresAt.getTime()).toBeGreaterThan(createdAt.getTime())
  })

  it('ROUND-TRIP: the returned code actually works for POST /auth/register', async () => {
    const admin = await registerBootstrapAdmin()
    const { accessToken } = await login(admin.email)

    const inviteRes = await post('/auth/invites', {}, bearer(accessToken))
    expect(inviteRes.status).toBe(201)
    const { code } = (await inviteRes.json()) as { code: string }

    const regRes = await post('/auth/register', {
      email: 'round-trip-user@example.com',
      password: DEFAULT_PASSWORD,
      name: 'Round Trip User',
      inviteCode: code,
    })
    expect(regRes.status).toBe(201)
    const body = (await regRes.json()) as Record<string, unknown>
    expect(body['role']).toBe('user')
  })
})

describe('GET /auth/invites', () => {
  it('a freshly created invite reports a "pending" status, consistent across pending invites', async () => {
    const admin = await registerBootstrapAdmin()
    const { accessToken } = await login(admin.email)

    const inviteRes1 = await post('/auth/invites', {}, bearer(accessToken))
    const invite1 = (await inviteRes1.json()) as { id: string }
    const inviteRes2 = await post('/auth/invites', {}, bearer(accessToken))
    const invite2 = (await inviteRes2.json()) as { id: string }

    const listRes = await get('/auth/invites', bearer(accessToken))
    expect(listRes.status).toBe(200)
    const list = (await listRes.json()) as Array<Record<string, unknown>>

    const entry1 = list.find((e) => e['id'] === invite1.id)
    const entry2 = list.find((e) => e['id'] === invite2.id)
    expect(entry1).toBeDefined()
    expect(entry2).toBeDefined()
    // Same status value across two still-pending invites.
    expect(entry1?.['status']).toBe(entry2?.['status'])
    expect(entry1?.['status']).toBeTruthy()
  })

  it('after redemption via /auth/register, the invite shows a distinct "used" state including who redeemed it', async () => {
    const admin = await registerBootstrapAdmin()
    const { accessToken } = await login(admin.email)

    const inviteRes = await post('/auth/invites', {}, bearer(accessToken))
    const invite = (await inviteRes.json()) as { id: string; code: string }

    const listBefore = await get('/auth/invites', bearer(accessToken))
    const before = (await listBefore.json()) as Array<Record<string, unknown>>
    const pendingStatus = before.find((e) => e['id'] === invite.id)?.['status']

    const redeemRes = await post('/auth/register', {
      email: 'redeemer@example.com',
      password: DEFAULT_PASSWORD,
      name: 'Redeemer',
      inviteCode: invite.code,
    })
    expect(redeemRes.status).toBe(201)

    const listAfter = await get('/auth/invites', bearer(accessToken))
    const after = (await listAfter.json()) as Array<Record<string, unknown>>
    const usedEntry = after.find((e) => e['id'] === invite.id)

    expect(usedEntry).toBeDefined()
    expect(usedEntry?.['status']).not.toBe(pendingStatus)
    // Should identify the redeeming user somehow (email is the most stable field to check).
    const usedEntryStr = JSON.stringify(usedEntry)
    expect(usedEntryStr).toContain('redeemer@example.com')
  })

  it('the ?status= filter (using the pending status value reported by the API) returns only matching invites', async () => {
    const admin = await registerBootstrapAdmin()
    const { accessToken } = await login(admin.email)

    // One invite left pending.
    const pendingInviteRes = await post('/auth/invites', {}, bearer(accessToken))
    const pendingInvite = (await pendingInviteRes.json()) as { id: string }

    // One invite redeemed (used).
    const usedInviteRes = await post('/auth/invites', {}, bearer(accessToken))
    const usedInvite = (await usedInviteRes.json()) as { id: string; code: string }
    const redeemRes = await post('/auth/register', {
      email: 'filter-redeemer@example.com',
      password: DEFAULT_PASSWORD,
      name: 'Filter Redeemer',
      inviteCode: usedInvite.code,
    })
    expect(redeemRes.status).toBe(201)

    const fullList = await get('/auth/invites', bearer(accessToken))
    const full = (await fullList.json()) as Array<Record<string, unknown>>
    const pendingStatusValue = full.find((e) => e['id'] === pendingInvite.id)?.['status'] as string

    const filteredRes = await get(`/auth/invites?status=${encodeURIComponent(pendingStatusValue)}`, bearer(accessToken))
    expect(filteredRes.status).toBe(200)
    const filtered = (await filteredRes.json()) as Array<Record<string, unknown>>

    expect(filtered.some((e) => e['id'] === pendingInvite.id)).toBe(true)
    expect(filtered.some((e) => e['id'] === usedInvite.id)).toBe(false)
    for (const entry of filtered) {
      expect(entry['status']).toBe(pendingStatusValue)
    }
  })
})

describe('DELETE /auth/invites/:id', () => {
  it('revoking a still-pending invite succeeds (200), and the code can no longer be used to register', async () => {
    const admin = await registerBootstrapAdmin()
    const { accessToken } = await login(admin.email)

    const inviteRes = await post('/auth/invites', {}, bearer(accessToken))
    const invite = (await inviteRes.json()) as { id: string; code: string }

    const revokeRes = await del(`/auth/invites/${invite.id}`, undefined, bearer(accessToken))
    expect(revokeRes.status).toBe(200)

    const regRes = await post('/auth/register', {
      email: 'revoked-target@example.com',
      password: DEFAULT_PASSWORD,
      name: 'Revoked Target',
      inviteCode: invite.code,
    })
    expect(regRes.status).toBe(400)
  })

  it('revoking an already-used invite fails (non-2xx)', async () => {
    const admin = await registerBootstrapAdmin()
    const { accessToken } = await login(admin.email)

    const inviteRes = await post('/auth/invites', {}, bearer(accessToken))
    const invite = (await inviteRes.json()) as { id: string; code: string }

    const redeemRes = await post('/auth/register', {
      email: 'used-target@example.com',
      password: DEFAULT_PASSWORD,
      name: 'Used Target',
      inviteCode: invite.code,
    })
    expect(redeemRes.status).toBe(201)

    const revokeRes = await del(`/auth/invites/${invite.id}`, undefined, bearer(accessToken))
    expect(revokeRes.status).not.toBe(200)
    expect(revokeRes.status).not.toBe(201)
    expect(revokeRes.status).toBeGreaterThanOrEqual(400)
  })

  it('revoking a nonexistent invite id fails with 404', async () => {
    const admin = await registerBootstrapAdmin()
    const { accessToken } = await login(admin.email)

    const res = await del('/auth/invites/does-not-exist-at-all', undefined, bearer(accessToken))
    expect(res.status).toBe(404)
  })
})

describe('GET /auth/admin/users', () => {
  it('returns an array of all registered users with email/name/role/createdAt and a numeric session-count field that reacts to login/logout', async () => {
    const admin = await registerBootstrapAdmin()
    const { accessToken } = await login(admin.email)
    const other = await seedUser('sessions-user@example.com', 'user')

    const listBefore = await get('/auth/admin/users', bearer(accessToken))
    expect(listBefore.status).toBe(200)
    const before = (await listBefore.json()) as Array<Record<string, unknown>>
    expect(Array.isArray(before)).toBe(true)

    const adminEntry = before.find((u) => u['id'] === admin.id)
    expect(adminEntry).toBeDefined()
    expect(adminEntry?.['email']).toBe(admin.email)
    expect(adminEntry?.['name']).toBeDefined()
    expect(adminEntry?.['role']).toBe('admin')
    expect(adminEntry?.['createdAt']).toBeDefined()

    const otherEntryBefore = before.find((u) => u['id'] === other.id)
    expect(otherEntryBefore).toBeDefined()
    const sessionCountFields = Object.keys(otherEntryBefore ?? {}).filter((k) =>
      /session/i.test(k),
    )
    expect(sessionCountFields.length).toBeGreaterThan(0)
    const sessionCountKey = sessionCountFields[0] as string
    expect(typeof otherEntryBefore?.[sessionCountKey]).toBe('number')
    expect(otherEntryBefore?.[sessionCountKey]).toBe(0)

    // Log the other user in — session count should become >= 1.
    const { res: loginRes } = await login(other.email)
    expect(loginRes.status).toBe(200)

    const listAfterLogin = await get('/auth/admin/users', bearer(accessToken))
    const afterLogin = (await listAfterLogin.json()) as Array<Record<string, unknown>>
    const otherEntryAfterLogin = afterLogin.find((u) => u['id'] === other.id)
    expect((otherEntryAfterLogin?.[sessionCountKey] as number)).toBeGreaterThanOrEqual(1)

    // Force-clear sessions — count should drop again.
    const clearRes = await del(`/auth/admin/users/${other.id}/sessions`, undefined, bearer(accessToken))
    expect(clearRes.status).toBe(200)

    const listAfterClear = await get('/auth/admin/users', bearer(accessToken))
    const afterClear = (await listAfterClear.json()) as Array<Record<string, unknown>>
    const otherEntryAfterClear = afterClear.find((u) => u['id'] === other.id)
    expect((otherEntryAfterClear?.[sessionCountKey] as number)).toBeLessThan(
      otherEntryAfterLogin?.[sessionCountKey] as number,
    )
  })
})

describe('PATCH /auth/admin/users/:id/role', () => {
  it('promoting a regular user to admin succeeds, and that user can then call admin endpoints with their own token', async () => {
    const admin = await registerBootstrapAdmin()
    const { accessToken } = await login(admin.email)
    const regular = await seedUser('promote-me@example.com', 'user')

    const promoteRes = await patchReq(`/auth/admin/users/${regular.id}/role`, { role: 'admin' }, bearer(accessToken))
    expect(promoteRes.status).toBe(200)

    const { accessToken: regularToken } = await login(regular.email)
    const selfAdminCheck = await get('/auth/admin/users', bearer(regularToken))
    expect(selfAdminCheck.status).toBe(200)
  })

  it('demoting an admin to user succeeds when at least one other admin still exists', async () => {
    const admin = await registerBootstrapAdmin()
    const { accessToken } = await login(admin.email)
    const secondAdmin = await seedUser('second-admin@example.com', 'admin')

    const demoteRes = await patchReq(`/auth/admin/users/${secondAdmin.id}/role`, { role: 'user' }, bearer(accessToken))
    expect(demoteRes.status).toBe(200)

    const listRes = await get('/auth/admin/users', bearer(accessToken))
    const list = (await listRes.json()) as Array<Record<string, unknown>>
    expect(list.find((u) => u['id'] === secondAdmin.id)?.['role']).toBe('user')
  })

  it('CRITICAL GUARD: demoting the bootstrap admin fails when they are the only admin, and their role is unchanged', async () => {
    const admin = await registerBootstrapAdmin()
    const { accessToken } = await login(admin.email)

    const demoteRes = await patchReq(`/auth/admin/users/${admin.id}/role`, { role: 'user' }, bearer(accessToken))
    expect(demoteRes.status).not.toBe(200)
    expect(demoteRes.status).toBeGreaterThanOrEqual(400)

    const listRes = await get('/auth/admin/users', bearer(accessToken))
    const list = (await listRes.json()) as Array<Record<string, unknown>>
    expect(list.find((u) => u['id'] === admin.id)?.['role']).toBe('admin')

    // Their token should still pass admin checks (role truly unchanged).
    const stillAdminCheck = await get('/auth/admin/users', bearer(accessToken))
    expect(stillAdminCheck.status).toBe(200)
  })
})

describe('DELETE /auth/admin/users/:id/sessions', () => {
  it("force-logs-out a target user's session: old refresh cookie stops working, but the account still exists and can log in fresh", async () => {
    const admin = await registerBootstrapAdmin()
    const { accessToken } = await login(admin.email)
    const target = await seedUser('force-logout-target@example.com', 'user')

    const { refreshCookie } = await login(target.email)
    expect(refreshCookie).toBeTruthy()

    const clearRes = await del(`/auth/admin/users/${target.id}/sessions`, undefined, bearer(accessToken))
    expect(clearRes.status).toBe(200)

    const refreshRes = await app.request('/auth/refresh', {
      method: 'POST',
      headers: { Cookie: `schloss_refresh=${refreshCookie}` },
    })
    expect(refreshRes.status).toBe(401)

    // Account still exists and password login still works.
    const reLoginRes = await post('/auth/login', { email: target.email, password: DEFAULT_PASSWORD })
    expect(reLoginRes.status).toBe(200)
  })

  it('does not require or check the target role: an admin can force-logout a regular user', async () => {
    const admin = await registerBootstrapAdmin()
    const { accessToken } = await login(admin.email)
    const target = await seedUser('regular-target@example.com', 'user')
    await login(target.email)

    const res = await del(`/auth/admin/users/${target.id}/sessions`, undefined, bearer(accessToken))
    expect(res.status).toBe(200)
  })

  it('an admin can force-logout another admin', async () => {
    const admin = await registerBootstrapAdmin()
    const { accessToken } = await login(admin.email)
    const otherAdmin = await seedUser('other-admin-target@example.com', 'admin')
    await login(otherAdmin.email)

    const res = await del(`/auth/admin/users/${otherAdmin.id}/sessions`, undefined, bearer(accessToken))
    expect(res.status).toBe(200)
  })
})

describe('DELETE /auth/admin/users/:id', () => {
  it("deleting another user's account with the correct acting-admin password succeeds, and the account is genuinely gone", async () => {
    const admin = await registerBootstrapAdmin()
    const { accessToken } = await login(admin.email)
    const target = await seedUser('delete-me@example.com', 'user')

    const res = await del(`/auth/admin/users/${target.id}`, { password: DEFAULT_PASSWORD }, bearer(accessToken))
    expect(res.status).toBe(200)
    expect(sqlite.prepare('SELECT user_id, initiated_by FROM deletion_jobs').get()).toEqual({
      user_id: target.id, initiated_by: 'admin',
    })
    expect(sqlite.prepare('SELECT count(*) AS count FROM deletion_job_targets').get()).toEqual({ count: 6 })

    const loginAfter = await post('/auth/login', { email: target.email, password: DEFAULT_PASSWORD })
    expect(loginAfter.status).not.toBe(200)
  })

  it("fails with the WRONG acting-admin password, and does not delete the target account", async () => {
    const admin = await registerBootstrapAdmin()
    const { accessToken } = await login(admin.email)
    const target = await seedUser('keep-me@example.com', 'user')

    const res = await del(`/auth/admin/users/${target.id}`, { password: 'totally-wrong-password' }, bearer(accessToken))
    expect(res.status).not.toBe(200)
    expect(res.status).toBeGreaterThanOrEqual(400)

    const loginAfter = await post('/auth/login', { email: target.email, password: DEFAULT_PASSWORD })
    expect(loginAfter.status).toBe(200)
  })

  it('CRITICAL GUARD: deleting the only remaining admin account fails even with the correct password, and the admin still exists', async () => {
    const admin = await registerBootstrapAdmin()
    const { accessToken } = await login(admin.email)

    const res = await del(`/auth/admin/users/${admin.id}`, { password: DEFAULT_PASSWORD }, bearer(accessToken))
    expect(res.status).not.toBe(200)
    expect(res.status).toBeGreaterThanOrEqual(400)

    const loginAfter = await post('/auth/login', { email: admin.email, password: DEFAULT_PASSWORD })
    expect(loginAfter.status).toBe(200)
  })
})

describe('GET /auth/admin/stats', () => {
  it('reports counts at least consistent with what was set up', async () => {
    const admin = await registerBootstrapAdmin()
    const { accessToken } = await login(admin.email)
    await seedUser('stats-user-1@example.com', 'user')
    await seedUser('stats-user-2@example.com', 'user')

    await post('/auth/invites', {}, bearer(accessToken))
    await post('/auth/invites', {}, bearer(accessToken))

    const res = await get('/auth/admin/stats', bearer(accessToken))
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>

    // Discover plausible numeric fields empirically rather than hardcoding names.
    const numericEntries = Object.entries(body).filter(([, v]) => typeof v === 'number')
    expect(numericEntries.length).toBeGreaterThan(0)

    const totalUsersKey = Object.keys(body).find((k) => /total.*user|user.*total/i.test(k))
    expect(totalUsersKey).toBeDefined()
    expect(body[totalUsersKey as string]).toBeGreaterThanOrEqual(3) // admin + 2 seeded

    const pendingInvitesKey = Object.keys(body).find((k) => /pending.*invite|invite.*pending/i.test(k))
    expect(pendingInvitesKey).toBeDefined()
    expect(body[pendingInvitesKey as string]).toBeGreaterThanOrEqual(2)
  })
})
