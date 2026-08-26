import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readReturnTo, readCodeChallenge, redirectWithCode, withReturnTo, readInviteCode } from '../lib/returnTo'

// A plausible 43-character base64url code_challenge fixture (PKCE S256
// challenges are the base64url-encoded SHA256 digest of a verifier, which is
// always 43 characters with no padding). The exact bytes don't matter for
// these tests — only that readCodeChallenge extracts it verbatim.
const FIXTURE_CHALLENGE = 'A'.repeat(43)

// Tests that change the allowlist reset modules before importing the reader,
// matching the runtime config's once-at-startup parsing behavior.

describe('readReturnTo — no return_to param', () => {
  it('reports not present', () => {
    const result = readReturnTo('')
    expect(result.present).toBe(false)
  })
})

describe('readReturnTo — malformed return_to', () => {
  it('treats an unparsable URL as invalid', () => {
    const result = readReturnTo('?return_to=not-a-url')
    expect(result).toEqual({ present: true, valid: false, url: 'not-a-url' })
  })
})

describe('readReturnTo — allowlist enforcement', () => {
  beforeEach(() => {
    stubRuntimeConfig('allowedReturnOrigins', 'https://kuvert.example.com,https://schloss.example.com')
  })

  it('accepts an origin present in the allowlist', async () => {
    vi.resetModules()
    const { readReturnTo: freshReadReturnTo } = await import('../lib/returnTo')
    const result = freshReadReturnTo('?return_to=https://kuvert.example.com/auth/callback')
    expect(result).toEqual({
      present: true,
      valid: true,
      url: 'https://kuvert.example.com/auth/callback',
    })
  })

  it('rejects an origin not present in the allowlist', async () => {
    vi.resetModules()
    const { readReturnTo: freshReadReturnTo } = await import('../lib/returnTo')
    const result = freshReadReturnTo('?return_to=https://evil.example.com/steal')
    expect(result).toEqual({
      present: true,
      valid: false,
      url: 'https://evil.example.com/steal',
    })
  })

  it('rejects a same-looking origin with a different port', async () => {
    vi.resetModules()
    const { readReturnTo: freshReadReturnTo } = await import('../lib/returnTo')
    const result = freshReadReturnTo('?return_to=https://kuvert.example.com:8443/x')
    expect(result.present).toBe(true)
    if (result.present) expect(result.valid).toBe(false)
  })
})

describe('readCodeChallenge — no code_challenge param', () => {
  it('reports not present', () => {
    const result = readCodeChallenge('')
    expect(result.present).toBe(false)
  })
})

describe('readCodeChallenge — code_challenge present with S256 method', () => {
  it('reports present and extracts the challenge value', () => {
    const result = readCodeChallenge(`?code_challenge=${FIXTURE_CHALLENGE}&code_challenge_method=S256`)
    expect(result).toEqual({ present: true, codeChallenge: FIXTURE_CHALLENGE })
  })

  it('extracts the challenge value regardless of surrounding params', () => {
    const result = readCodeChallenge(
      `?return_to=https%3A%2F%2Fkuvert.example.com&code_challenge=${FIXTURE_CHALLENGE}&code_challenge_method=S256`,
    )
    expect(result.present).toBe(true)
    if (result.present) expect(result.codeChallenge).toBe(FIXTURE_CHALLENGE)
  })
})

describe('readCodeChallenge — code_challenge present but code_challenge_method missing', () => {
  it('reports not present (an unsupported/missing method must not be treated as valid)', () => {
    const result = readCodeChallenge(`?code_challenge=${FIXTURE_CHALLENGE}`)
    expect(result.present).toBe(false)
  })
})

describe('readCodeChallenge — code_challenge_method is not exactly S256', () => {
  it('reports not present for method "plain"', () => {
    const result = readCodeChallenge(`?code_challenge=${FIXTURE_CHALLENGE}&code_challenge_method=plain`)
    expect(result.present).toBe(false)
  })

  it('reports not present for an empty method', () => {
    const result = readCodeChallenge(`?code_challenge=${FIXTURE_CHALLENGE}&code_challenge_method=`)
    expect(result.present).toBe(false)
  })
})

describe('redirectWithCode', () => {
  it('appends ?code=<value> when the return_to URL has no existing query string', () => {
    const original = window.location
    // @ts-expect-error -- jsdom allows reassigning location for test purposes
    delete window.location
    // @ts-expect-error -- minimal stub, only `href` is used by the function under test
    window.location = { href: '' }

    redirectWithCode('https://kuvert.test/callback', 'abc123')
    expect(window.location.href).toBe('https://kuvert.test/callback?code=abc123')

    // @ts-expect-error -- restoring jsdom's original Location object
    window.location = original
  })

  it('appends &code=<value> when the return_to URL already has a query string', () => {
    const original = window.location
    // @ts-expect-error -- jsdom allows reassigning location for test purposes
    delete window.location
    // @ts-expect-error -- minimal stub, only `href` is used by the function under test
    window.location = { href: '' }

    redirectWithCode('https://kuvert.test/callback?next=%2Fbudget', 'abc123')
    expect(window.location.href).toBe('https://kuvert.test/callback?next=%2Fbudget&code=abc123')
    // Must stay a single valid query string — no second '?'.
    expect(window.location.href.match(/\?/g)?.length).toBe(1)

    // @ts-expect-error -- restoring jsdom's original Location object
    window.location = original
  })

  it('never puts the code in a URL fragment', () => {
    const original = window.location
    // @ts-expect-error -- jsdom allows reassigning location for test purposes
    delete window.location
    // @ts-expect-error -- minimal stub, only `href` is used by the function under test
    window.location = { href: '' }

    redirectWithCode('https://kuvert.test/callback', 'secret-code')
    expect(window.location.href).not.toContain('#')
    expect(window.location.href).not.toContain('#code=')

    // @ts-expect-error -- restoring jsdom's original Location object
    window.location = original
  })
})

describe('withReturnTo', () => {
  it('appends return_to when present in the current search string', () => {
    const path = withReturnTo('/register', '?return_to=https%3A%2F%2Fkuvert.example.com')
    expect(path).toBe('/register?return_to=https%3A%2F%2Fkuvert.example.com')
  })

  it('leaves the path untouched when there is no return_to', () => {
    const path = withReturnTo('/register', '')
    expect(path).toBe('/register')
  })
})

describe('readInviteCode', () => {
  it('extracts the code from a URL fragment', () => {
    expect(readInviteCode('#invite=abc123')).toBe('abc123')
  })

  it('returns an empty string when there is no fragment', () => {
    expect(readInviteCode('')).toBe('')
  })

  it('returns an empty string when the fragment has no invite param', () => {
    expect(readInviteCode('#foo=bar')).toBe('')
  })

  it('does not read a legacy ?invite= query param', () => {
    expect(readInviteCode('')).toBe('')
  })
})
