/**
 * Integration tests for the public, unauthenticated shared theme endpoint
 * (GET /theme, PUT /theme).
 *
 * Isolation strategy mirrors admin.integration.test.ts / invites.integration.test.ts:
 *   - process.env is mutated at the very top of this module (before any imports
 *     that might read it at load time).
 *   - All project code is loaded via dynamic imports inside beforeAll, so the
 *     env values set here are what the modules actually see.
 *   - A fresh temp SQLite file is used exclusively by this test file.
 *   - The theme_preference table is wiped in beforeEach so every test starts
 *     with a genuinely empty (never-stored) slate.
 *
 * Written strictly from the API spec, without reading routes/theme.ts or the
 * themePreference table definition in db/schema.ts.
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
const DB_PATH = join(tmpdir(), `schlussel-test-theme-${testId}.db`)
const KEYS_DIR = join(tmpdir(), `schlussel-keys-theme-${testId}`)
const MIGRATIONS_DIR = fileURLToPath(new URL('../db/migrations', import.meta.url))

process.env['DATABASE_PATH'] = DB_PATH
process.env['KEYS_DIR'] = KEYS_DIR
process.env['JWT_ISSUER'] = 'schlussel'

// ── Module handles populated in beforeAll ───────────────────────────────────
let app: Hono
let sqlite: import('better-sqlite3').Database

// ── Setup / teardown ────────────────────────────────────────────────────────
beforeAll(async () => {
  mkdirSync(KEYS_DIR, { recursive: true })

  const [keysModule, themeModule, dbModule, migratorModule, honoModule] = await Promise.all([
    import('../utils/keys.js'),
    import('../routes/theme.js'),
    import('../db/index.js'),
    import('drizzle-orm/better-sqlite3/migrator'),
    import('hono'),
  ])

  const { initKeys, getJwks } = keysModule
  const { themeRouter } = themeModule
  const { db: dbInstance, sqlite: sqliteInstance } = dbModule
  const { migrate } = migratorModule
  const { Hono } = honoModule

  sqlite = sqliteInstance

  await initKeys()
  migrate(dbInstance, { migrationsFolder: MIGRATIONS_DIR })

  const testApp = new Hono()
  testApp.get('/.well-known/jwks.json', (c) => c.json(getJwks()))
  testApp.get('/health', (c) => c.json({ status: 'ok' }))
  testApp.route('/theme', themeRouter)

  app = testApp
})

beforeEach(() => {
  sqlite.exec('DELETE FROM theme_preference')
})

afterAll(() => {
  try { sqlite?.close() } catch { /* ignore */ }
  try { rmSync(DB_PATH) } catch { /* ignore */ }
  try { rmSync(KEYS_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
})

// ── Helpers ──────────────────────────────────────────────────────────────────
const JSON_HEADERS = { 'Content-Type': 'application/json' }

function get(path: string) {
  return app.request(path, { method: 'GET' })
}

function put(path: string, body: unknown) {
  return app.request(path, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  })
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('GET /theme', () => {
  it('returns { theme: null, updatedAt: 0 } when nothing has ever been stored', async () => {
    const res = await get('/theme')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { theme: string | null; updatedAt: number }
    expect(body).toEqual({ theme: null, updatedAt: 0 })
  })
})

describe('PUT /theme — happy path', () => {
  it('stores a valid body and echoes it back with 200', async () => {
    const res = await put('/theme', { theme: 'dark', updatedAt: 100 })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { theme: string; updatedAt: number }
    expect(body).toEqual({ theme: 'dark', updatedAt: 100 })
  })

  it('a subsequent GET /theme reflects the newly stored value', async () => {
    const putRes = await put('/theme', { theme: 'sepia', updatedAt: 42 })
    expect(putRes.status).toBe(200)

    const getRes = await get('/theme')
    expect(getRes.status).toBe(200)
    const body = (await getRes.json()) as { theme: string; updatedAt: number }
    expect(body).toEqual({ theme: 'sepia', updatedAt: 42 })
  })
})

describe('PUT /theme — last-write-wins semantics', () => {
  it('a NEWER updatedAt overwrites the previously stored value', async () => {
    const first = await put('/theme', { theme: 'light', updatedAt: 10 })
    expect(first.status).toBe(200)

    const second = await put('/theme', { theme: 'oled', updatedAt: 20 })
    expect(second.status).toBe(200)
    const secondBody = (await second.json()) as { theme: string; updatedAt: number }
    expect(secondBody).toEqual({ theme: 'oled', updatedAt: 20 })

    const getRes = await get('/theme')
    const getBody = (await getRes.json()) as { theme: string; updatedAt: number }
    expect(getBody).toEqual({ theme: 'oled', updatedAt: 20 })
  })

  it('an OLDER updatedAt does NOT overwrite, and returns the existing value with 200 (not an error)', async () => {
    const first = await put('/theme', { theme: 'dark', updatedAt: 50 })
    expect(first.status).toBe(200)

    const second = await put('/theme', { theme: 'light', updatedAt: 10 })
    expect(second.status).toBe(200)
    const secondBody = (await second.json()) as { theme: string; updatedAt: number }
    expect(secondBody).toEqual({ theme: 'dark', updatedAt: 50 })

    const getRes = await get('/theme')
    const getBody = (await getRes.json()) as { theme: string; updatedAt: number }
    expect(getBody).toEqual({ theme: 'dark', updatedAt: 50 })
  })

  it('an EQUAL updatedAt does NOT overwrite, and returns the existing value with 200 (not an error)', async () => {
    const first = await put('/theme', { theme: 'sepia', updatedAt: 30 })
    expect(first.status).toBe(200)

    const second = await put('/theme', { theme: 'oled', updatedAt: 30 })
    expect(second.status).toBe(200)
    const secondBody = (await second.json()) as { theme: string; updatedAt: number }
    expect(secondBody).toEqual({ theme: 'sepia', updatedAt: 30 })

    const getRes = await get('/theme')
    const getBody = (await getRes.json()) as { theme: string; updatedAt: number }
    expect(getBody).toEqual({ theme: 'sepia', updatedAt: 30 })
  })
})

describe('PUT /theme — validation errors (400)', () => {
  it('rejects an invalid theme string not in the 4 allowed values', async () => {
    const res = await put('/theme', { theme: 'neon', updatedAt: 5 })
    expect(res.status).toBe(400)
  })

  it('rejects a missing theme field', async () => {
    const res = await put('/theme', { updatedAt: 5 })
    expect(res.status).toBe(400)
  })

  it('rejects a negative updatedAt', async () => {
    const res = await put('/theme', { theme: 'dark', updatedAt: -1 })
    expect(res.status).toBe(400)
  })

  it('rejects a missing updatedAt', async () => {
    const res = await put('/theme', { theme: 'dark' })
    expect(res.status).toBe(400)
  })

  it('rejects a non-integer (float) updatedAt', async () => {
    const res = await put('/theme', { theme: 'dark', updatedAt: 1.5 })
    expect(res.status).toBe(400)
  })

  it('rejects a non-numeric updatedAt', async () => {
    const res = await put('/theme', { theme: 'dark', updatedAt: 'not-a-number' })
    expect(res.status).toBe(400)
  })

  it('a rejected PUT does not change what a later GET reports', async () => {
    const good = await put('/theme', { theme: 'light', updatedAt: 7 })
    expect(good.status).toBe(200)

    const bad = await put('/theme', { theme: 'invalid-theme', updatedAt: 999 })
    expect(bad.status).toBe(400)

    const getRes = await get('/theme')
    const body = (await getRes.json()) as { theme: string; updatedAt: number }
    expect(body).toEqual({ theme: 'light', updatedAt: 7 })
  })
})
