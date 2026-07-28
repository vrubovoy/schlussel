/**
 * Integration tests for the OAuth2 Authorization Code + PKCE flow added to
 * POST /auth/login (codeChallenge / codeChallengeMethod) and the new
 * POST /auth/token exchange endpoint.
 *
 * Follows the same isolation strategy as auth.integration.test.ts: env vars
 * set before any dynamic imports, a fresh temp SQLite file per test file,
 * tables wiped in beforeEach (children before parents, for FK), and a
 * manually-assembled Hono app in beforeAll.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { randomUUID, randomBytes, createHash } from 'crypto'
import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import type { Hono } from 'hono'

// ── Isolated environment ────────────────────────────────────────────────────
const testId = randomUUID().slice(0, 8)
const DB_PATH = join(tmpdir(), `schlussel-pkce-test-${testId}.db`)
const KEYS_DIR = join(tmpdir(), `schlussel-pkce-keys-${testId}`)
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
  // Mounted alongside authRouter, matching production (src/index.ts) -
  // one test below needs to mint a real invite to register a second user.
  testApp.route('/auth', adminRouter)

  app = testApp
})

beforeEach(() => {
  // Delete child rows first to satisfy FK, then parent.
  sqlite.exec('DELETE FROM auth_codes')
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

async function registerUser(
  email = 'alice@example.com',
  password = 'password123',
  name = 'Alice',
  inviteCode?: string,
) {
  return post('/auth/register', { email, password, name, ...(inviteCode ? { inviteCode } : {}) })
}

// Mints a real invite via the admin-only HTTP endpoint (mounted alongside
// authRouter above), for tests that register a second user in a
// beforeEach that already registered a first (admin) one.
async function mintInvite(adminAccessToken: string): Promise<string> {
  const res = await post('/auth/invites', {}, { Authorization: `Bearer ${adminAccessToken}` })
  const body = await res.json() as { code: string }
  return body.code
}

/** A syntactically valid (but not necessarily real-SHA256) 43-char base64url code_challenge. */
function fixtureCodeChallenge(): string {
  return randomBytes(32).toString('base64url')
}

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

// ── POST /auth/login — PKCE ─────────────────────────────────────────────────

describe('POST /auth/login — PKCE', () => {
  beforeEach(async () => {
    await registerUser()
  })

  it('with both codeChallenge and codeChallengeMethod: returns 200 with { code } and no accessToken', async () => {
    const res = await post('/auth/login', {
      email: 'alice@example.com',
      password: 'password123',
      codeChallenge: fixtureCodeChallenge(),
      codeChallengeMethod: 'S256',
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(typeof body['code']).toBe('string')
    expect((body['code'] as string).length).toBeGreaterThan(0)
    expect(body['accessToken']).toBeUndefined()
  })

  it('with both codeChallenge and codeChallengeMethod: also sets the schloss_refresh session cookie (SSO)', async () => {
    const res = await post('/auth/login', {
      email: 'alice@example.com',
      password: 'password123',
      codeChallenge: fixtureCodeChallenge(),
      codeChallengeMethod: 'S256',
    }, { 'X-Schlussel-Frontend': '1' })
    expect(res.status).toBe(200)
    const cookies = res.headers.getSetCookie()
    expect(cookies.length).toBeGreaterThan(0)
    expect(cookies.some((c) => c.startsWith('schloss_refresh='))).toBe(true)
  })

  it('with both codeChallenge and codeChallengeMethod: response has no "user" field required, but must not leak accessToken/refresh material', async () => {
    const res = await post('/auth/login', {
      email: 'alice@example.com',
      password: 'password123',
      codeChallenge: fixtureCodeChallenge(),
      codeChallengeMethod: 'S256',
    })
    const body = await res.json() as Record<string, unknown>
    expect(body['refreshToken']).toBeUndefined()
    expect(body['accessToken']).toBeUndefined()
  })

  it('only codeChallenge given (no codeChallengeMethod): returns 400', async () => {
    const res = await post('/auth/login', {
      email: 'alice@example.com',
      password: 'password123',
      codeChallenge: fixtureCodeChallenge(),
    })
    expect(res.status).toBe(400)
  })

  it('only codeChallengeMethod given (no codeChallenge): returns 400', async () => {
    const res = await post('/auth/login', {
      email: 'alice@example.com',
      password: 'password123',
      codeChallengeMethod: 'S256',
    })
    expect(res.status).toBe(400)
  })

  it('codeChallengeMethod other than "S256" (e.g. "plain"): returns 400', async () => {
    const res = await post('/auth/login', {
      email: 'alice@example.com',
      password: 'password123',
      codeChallenge: fixtureCodeChallenge(),
      codeChallengeMethod: 'plain',
    })
    expect(res.status).toBe(400)
  })

  it('codeChallenge shorter than 43 characters: returns 400', async () => {
    const res = await post('/auth/login', {
      email: 'alice@example.com',
      password: 'password123',
      codeChallenge: fixtureCodeChallenge().slice(0, 30),
      codeChallengeMethod: 'S256',
    })
    expect(res.status).toBe(400)
  })

  it('codeChallenge containing invalid base64url characters (+, /, =): returns 400', async () => {
    const bogus = 'a'.repeat(40) + '+/='
    expect(bogus.length).toBe(43)
    const res = await post('/auth/login', {
      email: 'alice@example.com',
      password: 'password123',
      codeChallenge: bogus,
      codeChallengeMethod: 'S256',
    })
    expect(res.status).toBe(400)
  })

  it('validation error happens before credential checking: bad codeChallengeMethod with wrong password is still 400, not 401', async () => {
    const res = await post('/auth/login', {
      email: 'alice@example.com',
      password: 'totally-wrong-password',
      codeChallenge: fixtureCodeChallenge(),
      codeChallengeMethod: 'plain',
    })
    expect(res.status).toBe(400)
  })

  it('wrong credentials with a valid codeChallenge: returns 401 and issues no code', async () => {
    const res = await post('/auth/login', {
      email: 'alice@example.com',
      password: 'wrongpassword',
      codeChallenge: fixtureCodeChallenge(),
      codeChallengeMethod: 'S256',
    })
    expect(res.status).toBe(401)
    const body = await res.json() as Record<string, unknown>
    expect(body['error']).toBeDefined()
    expect(body['code']).toBeUndefined()
  })

  it('unknown email with a valid codeChallenge: returns 401 and issues no code', async () => {
    const res = await post('/auth/login', {
      email: 'nobody@example.com',
      password: 'password123',
      codeChallenge: fixtureCodeChallenge(),
      codeChallengeMethod: 'S256',
    })
    expect(res.status).toBe(401)
  })
})

// ── POST /auth/token ─────────────────────────────────────────────────────────

describe('POST /auth/token', () => {
  beforeEach(async () => {
    await registerUser()
  })

  it('full round trip: a code issued by /auth/login with a real PKCE pair can be redeemed for an accessToken', async () => {
    const verifier = generateVerifier()
    const challenge = deriveChallenge(verifier)

    const loginRes = await post('/auth/login', {
      email: 'alice@example.com',
      password: 'password123',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
    })
    expect(loginRes.status).toBe(200)
    const { code } = await loginRes.json() as { code: string }
    expect(typeof code).toBe('string')

    const tokenRes = await post('/auth/token', { code, codeVerifier: verifier })
    expect(tokenRes.status).toBe(200)
    const body = await tokenRes.json() as Record<string, unknown>
    expect(typeof body['accessToken']).toBe('string')
    expect((body['accessToken'] as string).length).toBeGreaterThan(0)
    const user = body['user'] as Record<string, unknown>
    expect(user['email']).toBe('alice@example.com')
    expect(user['name']).toBe('Alice')

    // Redeemed here exactly like a real consumer app would (no
    // X-Schlussel-Frontend header) - correctly does NOT get its own
    // schloss_refresh cookie. See the trusted-origin gate tests further
    // down for the case where this same call IS made trusted.
    expect(getCookieValue(tokenRes, 'schloss_refresh')).toBeNull()
  })

  it('single-use: redeeming the same code a second time returns 400 and issues no token', async () => {
    const verifier = generateVerifier()
    const challenge = deriveChallenge(verifier)

    const loginRes = await post('/auth/login', {
      email: 'alice@example.com',
      password: 'password123',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
    })
    const { code } = await loginRes.json() as { code: string }

    const first = await post('/auth/token', { code, codeVerifier: verifier })
    expect(first.status).toBe(200)

    const second = await post('/auth/token', { code, codeVerifier: verifier })
    expect(second.status).toBe(400)
    const body = await second.json() as Record<string, unknown>
    expect(body['accessToken']).toBeUndefined()
  })

  it('wrong verifier: exchanging with a different (but valid-shaped) verifier than the one the challenge was derived from returns 400', async () => {
    const verifierA = generateVerifier()
    const verifierB = generateVerifier()
    expect(verifierA).not.toBe(verifierB)
    const challenge = deriveChallenge(verifierA)

    const loginRes = await post('/auth/login', {
      email: 'alice@example.com',
      password: 'password123',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
    })
    const { code } = await loginRes.json() as { code: string }

    const tokenRes = await post('/auth/token', { code, codeVerifier: verifierB })
    expect(tokenRes.status).toBe(400)
  })

  it('unknown/garbage code: returns 400', async () => {
    const res = await post('/auth/token', {
      code: 'this-code-was-never-issued-by-anyone',
      codeVerifier: generateVerifier(),
    })
    expect(res.status).toBe(400)
  })

  it('expired code: returns 400 after advancing time past the 60s TTL', async () => {
    const verifier = generateVerifier()
    const challenge = deriveChallenge(verifier)

    const loginRes = await post('/auth/login', {
      email: 'alice@example.com',
      password: 'password123',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
    })
    expect(loginRes.status).toBe(200)
    const { code } = await loginRes.json() as { code: string }

    vi.useFakeTimers()
    try {
      vi.advanceTimersByTime(61 * 1000)
      const tokenRes = await post('/auth/token', { code, codeVerifier: verifier })
      expect(tokenRes.status).toBe(400)
    } finally {
      vi.useRealTimers()
    }
  })

  it('malformed body: missing code returns 400', async () => {
    const res = await post('/auth/token', { codeVerifier: generateVerifier() })
    expect(res.status).toBe(400)
  })

  it('malformed body: missing codeVerifier returns 400', async () => {
    const res = await post('/auth/token', { code: 'some-code-value' })
    expect(res.status).toBe(400)
  })

  it('malformed body: codeVerifier shorter than 43 characters returns 400', async () => {
    const res = await post('/auth/token', { code: 'some-code-value', codeVerifier: generateVerifier(42) })
    expect(res.status).toBe(400)
  })

  it('malformed body: codeVerifier longer than 128 characters returns 400', async () => {
    const res = await post('/auth/token', { code: 'some-code-value', codeVerifier: generateVerifier(129) })
    expect(res.status).toBe(400)
  })

  it('malformed body: codeVerifier with characters outside the allowed charset returns 400', async () => {
    const bogus = 'a'.repeat(60) + '+/='
    const res = await post('/auth/token', { code: 'some-code-value', codeVerifier: bogus })
    expect(res.status).toBe(400)
  })

  it('malformed body: completely empty body returns 400', async () => {
    const res = await post('/auth/token', {})
    expect(res.status).toBe(400)
  })
})

// ── POST /auth/refresh — codeChallenge extension (silent re-auth / SSO) ────

describe('POST /auth/refresh — codeChallenge extension', () => {
  let refreshCookie: string
  let aliceAccessToken: string

  beforeEach(async () => {
    await registerUser()
    const loginRes = await post('/auth/login', {
      email: 'alice@example.com',
      password: 'password123',
    }, { 'X-Schlussel-Frontend': '1' })
    refreshCookie = getCookieValue(loginRes, 'schloss_refresh') ?? ''
    expect(refreshCookie).not.toBe('')
    const loginBody = await loginRes.json() as Record<string, unknown>
    aliceAccessToken = loginBody['accessToken'] as string
    // jose uses second-precision iat; ensure a rotated token gets a
    // different iat (and thus a different signature) from the original.
    await new Promise((r) => setTimeout(r, 1100))
  })

  function refreshWithCookie(body: unknown | undefined, cookie: string, extraHeaders?: Record<string, string>) {
    return app.request('/auth/refresh', {
      method: 'POST',
      headers: {
        ...(cookie ? { Cookie: `schloss_refresh=${cookie}` } : {}),
        ...(body !== undefined ? JSON_HEADERS : {}),
        ...extraHeaders,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  }

  it('valid codeChallenge + valid refresh cookie: returns 200 with { code } (no accessToken), and rotates the session cookie', async () => {
    const verifier = generateVerifier()
    const challenge = deriveChallenge(verifier)

    const res = await refreshWithCookie(
      { codeChallenge: challenge, codeChallengeMethod: 'S256' },
      refreshCookie,
      { 'X-Schlussel-Frontend': '1' },
    )
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(typeof body['code']).toBe('string')
    expect((body['code'] as string).length).toBeGreaterThan(0)
    expect(body['accessToken']).toBeUndefined()

    const newCookie = getCookieValue(res, 'schloss_refresh')
    expect(newCookie).not.toBeNull()
    expect(newCookie).not.toBe(refreshCookie)
  })

  it('the issued code is redeemable via /auth/token for the same user the cookie belonged to', async () => {
    const verifier = generateVerifier()
    const challenge = deriveChallenge(verifier)

    const refreshRes = await refreshWithCookie(
      { codeChallenge: challenge, codeChallengeMethod: 'S256' },
      refreshCookie,
    )
    expect(refreshRes.status).toBe(200)
    const { code } = await refreshRes.json() as { code: string }

    const tokenRes = await post('/auth/token', { code, codeVerifier: verifier })
    expect(tokenRes.status).toBe(200)
    const body = await tokenRes.json() as Record<string, unknown>
    expect(typeof body['accessToken']).toBe('string')
    const user = body['user'] as Record<string, unknown>
    expect(user['email']).toBe('alice@example.com')
    expect(user['name']).toBe('Alice')
  })

  it('the issued code is bound to the correct user, distinct from another logged-in user', async () => {
    const inviteCode = await mintInvite(aliceAccessToken)
    await registerUser('bob@example.com', 'bobpassword', 'Bob', inviteCode)
    const bobLogin = await post('/auth/login', {
      email: 'bob@example.com',
      password: 'bobpassword',
    }, { 'X-Schlussel-Frontend': '1' })
    const bobCookie = getCookieValue(bobLogin, 'schloss_refresh') ?? ''

    const verifier = generateVerifier()
    const challenge = deriveChallenge(verifier)
    const refreshRes = await refreshWithCookie(
      { codeChallenge: challenge, codeChallengeMethod: 'S256' },
      bobCookie,
    )
    expect(refreshRes.status).toBe(200)
    const { code } = await refreshRes.json() as { code: string }

    const tokenRes = await post('/auth/token', { code, codeVerifier: verifier })
    expect(tokenRes.status).toBe(200)
    const body = await tokenRes.json() as Record<string, unknown>
    const user = body['user'] as Record<string, unknown>
    expect(user['email']).toBe('bob@example.com')
  })

  it('code issued via /auth/refresh is single-use, just like a login-issued code', async () => {
    const verifier = generateVerifier()
    const challenge = deriveChallenge(verifier)
    const refreshRes = await refreshWithCookie(
      { codeChallenge: challenge, codeChallengeMethod: 'S256' },
      refreshCookie,
    )
    const { code } = await refreshRes.json() as { code: string }

    const first = await post('/auth/token', { code, codeVerifier: verifier })
    expect(first.status).toBe(200)
    const second = await post('/auth/token', { code, codeVerifier: verifier })
    expect(second.status).toBe(400)
  })

  it('codeChallenge given but no refresh cookie at all: returns 401 and issues no code', async () => {
    const res = await refreshWithCookie(
      { codeChallenge: fixtureCodeChallenge(), codeChallengeMethod: 'S256' },
      '',
    )
    expect(res.status).toBe(401)
    const body = await res.json() as Record<string, unknown>
    expect(body['code']).toBeUndefined()
  })

  it('codeChallenge given with an invalid/garbage refresh cookie: returns 401 and issues no code', async () => {
    const res = await refreshWithCookie(
      { codeChallenge: fixtureCodeChallenge(), codeChallengeMethod: 'S256' },
      'totallyinvalidtoken',
    )
    expect(res.status).toBe(401)
    const body = await res.json() as Record<string, unknown>
    expect(body['code']).toBeUndefined()
  })

  it('malformed body: codeChallenge without codeChallengeMethod returns 400 and does not touch the cookie', async () => {
    const res = await refreshWithCookie({ codeChallenge: fixtureCodeChallenge() }, refreshCookie)
    expect(res.status).toBe(400)
    expect(res.headers.getSetCookie()).toEqual([])
  })

  it('malformed body: codeChallengeMethod without codeChallenge returns 400 and does not touch the cookie', async () => {
    const res = await refreshWithCookie({ codeChallengeMethod: 'S256' }, refreshCookie)
    expect(res.status).toBe(400)
    expect(res.headers.getSetCookie()).toEqual([])
  })

  it('malformed body: codeChallengeMethod other than "S256" returns 400 and does not touch the cookie', async () => {
    const res = await refreshWithCookie(
      { codeChallenge: fixtureCodeChallenge(), codeChallengeMethod: 'plain' },
      refreshCookie,
    )
    expect(res.status).toBe(400)
    expect(res.headers.getSetCookie()).toEqual([])
  })

  it('malformed body: codeChallenge shorter than 43 characters returns 400 and does not touch the cookie', async () => {
    const res = await refreshWithCookie(
      { codeChallenge: fixtureCodeChallenge().slice(0, 30), codeChallengeMethod: 'S256' },
      refreshCookie,
    )
    expect(res.status).toBe(400)
    expect(res.headers.getSetCookie()).toEqual([])
  })

  it('malformed body: codeChallenge with invalid base64url characters returns 400 and does not touch the cookie', async () => {
    const bogus = 'a'.repeat(40) + '+/='
    expect(bogus.length).toBe(43)
    const res = await refreshWithCookie(
      { codeChallenge: bogus, codeChallengeMethod: 'S256' },
      refreshCookie,
    )
    expect(res.status).toBe(400)
    expect(res.headers.getSetCookie()).toEqual([])
  })

  it('regression: no body at all still behaves as a plain refresh (200, { accessToken }, cookie rotated when trusted)', async () => {
    const res = await refreshWithCookie(undefined, refreshCookie, { 'X-Schlussel-Frontend': '1' })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(typeof body['accessToken']).toBe('string')
    expect(body['code']).toBeUndefined()
    const newCookie = getCookieValue(res, 'schloss_refresh')
    expect(newCookie).not.toBeNull()
    expect(newCookie).not.toBe(refreshCookie)
  })

  it('regression: an empty JSON body {} still behaves as a plain refresh (200, { accessToken })', async () => {
    const res = await refreshWithCookie({}, refreshCookie)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(typeof body['accessToken']).toBe('string')
    expect(body['code']).toBeUndefined()
  })

  it('regression: plain refresh (no body) with no cookie still returns 401', async () => {
    const res = await refreshWithCookie(undefined, '')
    expect(res.status).toBe(401)
  })
})

// ── POST /auth/register — unchanged regression ──────────────────────────────

describe('POST /auth/register — unaffected by the PKCE change', () => {
  it('still just returns the created user (201), no code/token involved, even if PKCE-like fields are sent', async () => {
    const res = await post('/auth/register', {
      email: 'carol@example.com',
      password: 'password123',
      name: 'Carol',
      // These are not part of the register contract; the endpoint must
      // ignore them rather than erroring out or acting on them.
      codeChallenge: fixtureCodeChallenge(),
      codeChallengeMethod: 'S256',
    })
    expect(res.status).toBe(201)
    const body = await res.json() as Record<string, unknown>
    expect(body['email']).toBe('carol@example.com')
    expect(body['code']).toBeUndefined()
    expect(body['accessToken']).toBeUndefined()
    expect(res.headers.getSetCookie()).toEqual([])
  })
})
