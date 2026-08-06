/**
 * Unit tests for JWT sign/verify utilities (src/utils/jwt.ts).
 *
 * Isolation: a dedicated temp KEYS_DIR is used so key files don't interfere
 * with production data or other test suites.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomUUID } from 'crypto'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const testId = randomUUID().slice(0, 8)
const KEYS_DIR = join(tmpdir(), `schlussel-jwt-unit-${testId}`)

process.env['KEYS_DIR'] = KEYS_DIR
process.env['JWT_ISSUER'] = 'schlussel'

// Matches the JwtPayload interface from src/utils/jwt.ts
type JwtPayload = { sub: string; email: string; name: string; role: 'admin' | 'user' }

let signAccessToken: (payload: JwtPayload) => Promise<string>
let signRefreshToken: (userId: string) => Promise<string>
let verifyToken: (token: string) => Promise<Record<string, unknown>>

const ALICE: JwtPayload = {
  sub: 'user-alice-123',
  email: 'alice@example.com',
  name: 'Alice',
  role: 'user',
}

beforeAll(async () => {
  mkdirSync(KEYS_DIR, { recursive: true })
  const keysModule = await import('../utils/keys.js')
  await keysModule.initKeys()
  const jwtModule = await import('../utils/jwt.js')
  signAccessToken = jwtModule.signAccessToken
  signRefreshToken = jwtModule.signRefreshToken
  verifyToken = jwtModule.verifyToken
})

afterAll(() => {
  try { rmSync(KEYS_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
})

// ── signAccessToken ───────────────────────────────────────────────────────────

describe('signAccessToken', () => {
  it('returns a non-empty string', async () => {
    const token = await signAccessToken(ALICE)
    expect(typeof token).toBe('string')
    expect(token.length).toBeGreaterThan(0)
  })

  it('returns a JWT with three dot-separated segments', async () => {
    const token = await signAccessToken(ALICE)
    expect(token.split('.').length).toBe(3)
  })

  it('header declares alg: RS256', async () => {
    const token = await signAccessToken(ALICE)
    const header = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString())
    expect(header['alg']).toBe('RS256')
  })

  it('payload contains sub equal to user id', async () => {
    const token = await signAccessToken(ALICE)
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString())
    expect(payload['sub']).toBe(ALICE.sub)
  })

  it('payload contains email', async () => {
    const token = await signAccessToken(ALICE)
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString())
    expect(payload['email']).toBe(ALICE.email)
  })

  it('payload contains name', async () => {
    const token = await signAccessToken(ALICE)
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString())
    expect(payload['name']).toBe(ALICE.name)
  })

  it('payload contains role', async () => {
    const token = await signAccessToken(ALICE)
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString())
    expect(payload['role']).toBe(ALICE.role)
  })

  it('payload contains exp (expiry claim)', async () => {
    const token = await signAccessToken(ALICE)
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString())
    expect(typeof payload['exp']).toBe('number')
  })

  it('payload contains weekStart/dateFormat/timezone when given, null when omitted', async () => {
    const withPrefs = await signAccessToken({ ...ALICE, weekStart: 'sunday', dateFormat: 'ymd', timezone: 'Europe/Moscow' })
    const prefsPayload = JSON.parse(Buffer.from(withPrefs.split('.')[1]!, 'base64url').toString())
    expect(prefsPayload['weekStart']).toBe('sunday')
    expect(prefsPayload['dateFormat']).toBe('ymd')
    expect(prefsPayload['timezone']).toBe('Europe/Moscow')

    const withoutPrefs = await signAccessToken(ALICE)
    const noPrefsPayload = JSON.parse(Buffer.from(withoutPrefs.split('.')[1]!, 'base64url').toString())
    expect(noPrefsPayload['weekStart']).toBe(null)
    expect(noPrefsPayload['dateFormat']).toBe(null)
    expect(noPrefsPayload['timezone']).toBe(null)
  })

  it('access token expires roughly 15 minutes in the future', async () => {
    const before = Math.floor(Date.now() / 1000)
    const token = await signAccessToken(ALICE)
    const after = Math.floor(Date.now() / 1000)
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString())
    const exp = payload['exp'] as number
    const expectedExp = before + 14 * 60 // at least 14 minutes
    expect(exp).toBeGreaterThanOrEqual(expectedExp)
    expect(exp).toBeLessThanOrEqual(after + 16 * 60) // at most 16 minutes
  })

  it('two tokens for the same user issued in different seconds are different', async () => {
    const t1 = await signAccessToken(ALICE)
    // jose truncates iat to whole seconds; wait 1.1 s to cross the boundary
    await new Promise((r) => setTimeout(r, 1100))
    const t2 = await signAccessToken(ALICE)
    expect(t1).not.toBe(t2)
  })
})

// ── signRefreshToken ─────────────────────────────────────────────────────────

describe('signRefreshToken', () => {
  it('returns a non-empty string', async () => {
    const token = await signRefreshToken(ALICE.sub)
    expect(typeof token).toBe('string')
    expect(token.length).toBeGreaterThan(0)
  })

  it('returns a JWT with three dot-separated segments', async () => {
    const token = await signRefreshToken(ALICE.sub)
    expect(token.split('.').length).toBe(3)
  })

  it('header declares alg: RS256', async () => {
    const token = await signRefreshToken(ALICE.sub)
    const header = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString())
    expect(header['alg']).toBe('RS256')
  })

  it('payload contains exp (expiry claim)', async () => {
    const token = await signRefreshToken(ALICE.sub)
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString())
    expect(typeof payload['exp']).toBe('number')
  })

  it('refresh token expires roughly 7 days in the future', async () => {
    const before = Math.floor(Date.now() / 1000)
    const token = await signRefreshToken(ALICE.sub)
    const after = Math.floor(Date.now() / 1000)
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString())
    const exp = payload['exp'] as number
    const sevenDays = 7 * 24 * 60 * 60
    expect(exp).toBeGreaterThanOrEqual(before + sevenDays - 60) // 1 minute tolerance
    expect(exp).toBeLessThanOrEqual(after + sevenDays + 60)
  })

  it('access token and refresh token for the same user are distinct strings', async () => {
    const access = await signAccessToken(ALICE)
    const refresh = await signRefreshToken(ALICE.sub)
    expect(access).not.toBe(refresh)
  })
})

// ── verifyToken ───────────────────────────────────────────────────────────────

describe('verifyToken', () => {
  it('returns a payload object for a valid access token', async () => {
    const token = await signAccessToken(ALICE)
    const payload = await verifyToken(token)
    expect(typeof payload).toBe('object')
    expect(payload).not.toBeNull()
  })

  it('returned payload includes the sub claim', async () => {
    const token = await signAccessToken(ALICE)
    const payload = await verifyToken(token)
    expect(payload['sub']).toBe(ALICE.sub)
  })

  it('returned payload includes email', async () => {
    const token = await signAccessToken(ALICE)
    const payload = await verifyToken(token)
    expect(payload['email']).toBe(ALICE.email)
  })

  it('returned payload includes role', async () => {
    const token = await signAccessToken(ALICE)
    const payload = await verifyToken(token)
    expect(payload['role']).toBe(ALICE.role)
  })

  it('round-trips weekStart/dateFormat/timezone through sign -> verify', async () => {
    const token = await signAccessToken({ ...ALICE, weekStart: 'sunday', dateFormat: 'ymd', timezone: 'Europe/Moscow' })
    const payload = await verifyToken(token)
    expect(payload.weekStart).toBe('sunday')
    expect(payload.dateFormat).toBe('ymd')
    expect(payload.timezone).toBe('Europe/Moscow')
  })

  it('weekStart/dateFormat/timezone are null when never set', async () => {
    const token = await signAccessToken(ALICE)
    const payload = await verifyToken(token)
    expect(payload.weekStart).toBe(null)
    expect(payload.dateFormat).toBe(null)
    expect(payload.timezone).toBe(null)
  })

  it('rejects a token with a tampered signature', async () => {
    const token = await signAccessToken(ALICE)
    const parts = token.split('.')
    const badSig = parts[2]!.slice(0, -3) + 'XXX'
    const tampered = `${parts[0]}.${parts[1]}.${badSig}`
    await expect(verifyToken(tampered)).rejects.toThrow()
  })

  it('rejects a token with a tampered payload', async () => {
    const token = await signAccessToken(ALICE)
    const parts = token.split('.')
    // Replace the payload with a modified one
    const fakePayload = Buffer.from(
      JSON.stringify({ sub: 'evil', email: 'hacker@evil.com', role: 'admin', exp: 9999999999 }),
    ).toString('base64url')
    const tampered = `${parts[0]}.${fakePayload}.${parts[2]}`
    await expect(verifyToken(tampered)).rejects.toThrow()
  })

  it('rejects an empty string', async () => {
    await expect(verifyToken('')).rejects.toThrow()
  })

  it('rejects a random non-JWT string', async () => {
    await expect(verifyToken('not.a.jwt')).rejects.toThrow()
  })

  it('rejects a token with alg: none attack (unsigned)', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(
      JSON.stringify({ sub: ALICE.id, email: ALICE.email, exp: 9999999999 }),
    ).toString('base64url')
    const unsignedToken = `${header}.${payload}.`
    await expect(verifyToken(unsignedToken)).rejects.toThrow()
  })

  it('rejects an expired token', async () => {
    vi.useFakeTimers()
    try {
      const token = await signAccessToken(ALICE)
      // Advance past 15-minute access token lifetime
      vi.advanceTimersByTime(16 * 60 * 1000)
      await expect(verifyToken(token)).rejects.toThrow()
    } finally {
      vi.useRealTimers()
    }
  })

  it('verifies a valid refresh token', async () => {
    const token = await signRefreshToken(ALICE.sub)
    await expect(verifyToken(token)).resolves.toBeDefined()
  })
})
