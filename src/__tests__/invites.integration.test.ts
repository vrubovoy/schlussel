/**
 * Integration tests for invite-gated registration (POST /auth/register).
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
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { randomUUID, createHash } from 'crypto'
import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import type { Hono } from 'hono'
import type { invites as InvitesTable } from '../db/schema.js'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

// ── Isolated environment ────────────────────────────────────────────────────
const testId = randomUUID().slice(0, 8)
const DB_PATH = join(tmpdir(), `schlussel-test-invites-${testId}.db`)
const KEYS_DIR = join(tmpdir(), `schlussel-keys-invites-${testId}`)
const MIGRATIONS_DIR = fileURLToPath(new URL('../db/migrations', import.meta.url))

process.env['DATABASE_PATH'] = DB_PATH
process.env['KEYS_DIR'] = KEYS_DIR
process.env['JWT_ISSUER'] = 'schlussel'

// ── Module handles populated in beforeAll ───────────────────────────────────
let app: Hono
let sqlite: import('better-sqlite3').Database
let db: BetterSQLite3Database<Record<string, unknown>>
let invites: typeof InvitesTable

// ── Setup / teardown ────────────────────────────────────────────────────────
beforeAll(async () => {
  mkdirSync(KEYS_DIR, { recursive: true })

  const [keysModule, authModule, adminModule, dbModule, schemaModule, migratorModule, honoModule] =
    await Promise.all([
      import('../utils/keys.js'),
      import('../routes/auth.js'),
      import('../routes/admin.js'),
      import('../db/index.js'),
      import('../db/schema.js'),
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
  invites = schemaModule.invites

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

function post(path: string, body: unknown, extraHeaders?: Record<string, string>) {
  return app.request(path, {
    method: 'POST',
    headers: { ...JSON_HEADERS, ...extraHeaders },
    body: JSON.stringify(body),
  })
}

async function register(
  email: string,
  password = 'password123',
  name = 'Test User',
  inviteCode?: string,
) {
  const body: Record<string, unknown> = { email, password, name }
  if (inviteCode !== undefined) body['inviteCode'] = inviteCode
  return post('/auth/register', body)
}

/** Registers the very first (bootstrap admin) user, no invite required. */
async function registerBootstrapAdmin() {
  const res = await register('bootstrap-admin@example.com', 'password123', 'Bootstrap Admin')
  expect(res.status).toBe(201)
  return (await res.json()) as { id: string; email: string; name: string; role: string }
}

/** Directly seeds an invite row into the DB, bypassing the admin API. */
function seedInvite(overrides: {
  rawCode: string
  createdByUserId: string
  createdAt?: Date
  expiresAt?: Date
  revokedAt?: Date | null
  usedAt?: Date | null
  usedByUserId?: string | null
}) {
  const now = new Date()
  const id = randomUUID()
  db.insert(invites)
    .values({
      id,
      codeHash: createHash('sha256').update(overrides.rawCode).digest('hex'),
      createdByUserId: overrides.createdByUserId,
      createdAt: overrides.createdAt ?? now,
      expiresAt: overrides.expiresAt ?? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      revokedAt: overrides.revokedAt ?? null,
      usedAt: overrides.usedAt ?? null,
      usedByUserId: overrides.usedByUserId ?? null,
    })
    .run()
  return id
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('POST /auth/register — bootstrap (first user, no invite required)', () => {
  it('succeeds without an inviteCode when the users table is empty, and grants admin role', async () => {
    const res = await register('first@example.com', 'password123', 'First User')
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['role']).toBe('admin')
    expect(body['email']).toBe('first@example.com')
  })
})

describe('POST /auth/register — invite gating once at least one user exists', () => {
  it('requires an inviteCode once a user already exists; omitting it returns 400 (not 201)', async () => {
    await registerBootstrapAdmin()

    const res = await register('second@example.com', 'password123', 'Second User')
    expect(res.status).toBe(400)
    expect(res.status).not.toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(typeof body['error']).toBe('string')
  })

  it('a syntactically-plausible but nonexistent invite code fails with 400', async () => {
    await registerBootstrapAdmin()

    const res = await register(
      'nope@example.com',
      'password123',
      'Nope',
      'totally-nonexistent-code-1234',
    )
    expect(res.status).toBe(400)
    expect(res.status).not.toBe(201)
  })

  it('an expired invite (expiresAt in the past) fails with 400', async () => {
    const admin = await registerBootstrapAdmin()
    const rawCode = 'expired-raw-code-xyz'
    seedInvite({
      rawCode,
      createdByUserId: admin.id,
      createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 10),
      expiresAt: new Date(Date.now() - 1000 * 60 * 60), // 1 hour in the past
    })

    const res = await register('expired-user@example.com', 'password123', 'Expired User', rawCode)
    expect(res.status).toBe(400)
    expect(res.status).not.toBe(201)
  })

  it('a revoked invite (revokedAt set, usedAt still null) fails with 400', async () => {
    const admin = await registerBootstrapAdmin()
    const rawCode = 'revoked-raw-code-xyz'
    seedInvite({
      rawCode,
      createdByUserId: admin.id,
      revokedAt: new Date(),
      usedAt: null,
    })

    const res = await register('revoked-user@example.com', 'password123', 'Revoked User', rawCode)
    expect(res.status).toBe(400)
    expect(res.status).not.toBe(201)
  })

  it('a valid, unexpired, unrevoked, unused invite lets registration succeed with role "user" (not admin)', async () => {
    const admin = await registerBootstrapAdmin()
    const rawCode = 'valid-raw-code-xyz'
    seedInvite({ rawCode, createdByUserId: admin.id })

    const res = await register('invited-user@example.com', 'password123', 'Invited User', rawCode)
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['role']).toBe('user')
    expect(body['role']).not.toBe('admin')
  })

  it('reusing an already-consumed invite code fails with 400 (not 201, not 500)', async () => {
    const admin = await registerBootstrapAdmin()
    const rawCode = 'reuse-raw-code-xyz'
    seedInvite({ rawCode, createdByUserId: admin.id })

    const first = await register('first-redeemer@example.com', 'password123', 'First Redeemer', rawCode)
    expect(first.status).toBe(201)

    const second = await register('second-redeemer@example.com', 'password123', 'Second Redeemer', rawCode)
    expect(second.status).toBe(400)
    expect(second.status).not.toBe(201)
    expect(second.status).not.toBe(500)
  })

  it('an invite pre-marked as used (usedAt set) cannot be redeemed again — fails with 400', async () => {
    const admin = await registerBootstrapAdmin()
    // usedByUserId is nullable in the schema, so this can be seeded directly
    // without needing a real redeemer — keeps this test decoupled from
    // whatever POST /auth/register itself does with a *valid* invite code.
    const rawUsedCode = 'pre-used-raw-code-xyz'
    seedInvite({
      rawCode: rawUsedCode,
      createdByUserId: admin.id,
      usedAt: new Date(),
      usedByUserId: null,
    })

    const res = await register('late-comer@example.com', 'password123', 'Late Comer', rawUsedCode)
    expect(res.status).toBe(400)
    expect(res.status).not.toBe(201)
  })

  it('duplicate email still returns 409 regardless of invite validity', async () => {
    const admin = await registerBootstrapAdmin()
    const rawCode = 'dup-email-raw-code'
    seedInvite({ rawCode, createdByUserId: admin.id })

    const dup = await register(admin.email, 'password123', 'Duplicate Admin', rawCode)
    expect(dup.status).toBe(409)
  })

  it('password too short still returns 400 (pre-existing validation, sanity check)', async () => {
    const admin = await registerBootstrapAdmin()
    const rawCode = 'short-pw-raw-code'
    seedInvite({ rawCode, createdByUserId: admin.id })

    const res = await register('shortpw@example.com', 'short1', 'Short Pw', rawCode)
    expect(res.status).toBe(400)
  })

  it('missing name still returns 400 (pre-existing validation, sanity check)', async () => {
    const admin = await registerBootstrapAdmin()
    const rawCode = 'no-name-raw-code'
    seedInvite({ rawCode, createdByUserId: admin.id })

    const res = await post('/auth/register', {
      email: 'noname@example.com',
      password: 'password123',
      inviteCode: rawCode,
    })
    expect(res.status).toBe(400)
  })

  it('CONCURRENCY: two simultaneous registrations with the same valid invite code — exactly one succeeds', async () => {
    const admin = await registerBootstrapAdmin()
    const rawCode = 'concurrent-raw-code-xyz'
    seedInvite({ rawCode, createdByUserId: admin.id })

    // Fire both requests concurrently — do not await one before starting the other.
    const [resA, resB] = await Promise.all([
      register('concurrent-a@example.com', 'password123', 'Concurrent A', rawCode),
      register('concurrent-b@example.com', 'password123', 'Concurrent B', rawCode),
    ])

    const statuses = [resA.status, resB.status].sort()
    // Exactly one 201 and one 400 — never both succeeding, never both failing.
    expect(statuses).toEqual([201, 400])
  })
})
