import { describe, it, expect } from 'vitest'
import { generateCodeVerifier, generateCodeChallenge } from '../lib/pkce'

// Contract (RFC 7636): a code_verifier is a high-entropy cryptographic
// random string using the unreserved URL characters [A-Za-z0-9-._~], and
// the code_challenge (for S256) is BASE64URL-ENCODE(SHA256(ASCII(verifier))).
// We only assert base64url charset (no '+', '/', '=') since that's what the
// server-side and lib/returnTo.ts contracts in this codebase care about.

describe('generateCodeVerifier', () => {
  it('returns a non-empty string', async () => {
    const verifier = await generateCodeVerifier()
    expect(typeof verifier).toBe('string')
    expect(verifier.length).toBeGreaterThan(0)
  })

  it('is at least 43 characters long (PKCE minimum)', async () => {
    const verifier = await generateCodeVerifier()
    expect(verifier.length).toBeGreaterThanOrEqual(43)
  })

  it('is at most 128 characters long (PKCE maximum)', async () => {
    const verifier = await generateCodeVerifier()
    expect(verifier.length).toBeLessThanOrEqual(128)
  })

  it('contains only base64url-safe characters (no +, /, =)', async () => {
    const verifier = await generateCodeVerifier()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('generates a different verifier on each call', async () => {
    const v1 = await generateCodeVerifier()
    const v2 = await generateCodeVerifier()
    expect(v1).not.toBe(v2)
  })
})

describe('generateCodeChallenge', () => {
  it('returns a non-empty base64url string', async () => {
    const verifier = await generateCodeVerifier()
    const challenge = await generateCodeChallenge(verifier)
    expect(typeof challenge).toBe('string')
    expect(challenge.length).toBeGreaterThan(0)
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('is deterministic: the same verifier always yields the same challenge', async () => {
    const verifier = await generateCodeVerifier()
    const c1 = await generateCodeChallenge(verifier)
    const c2 = await generateCodeChallenge(verifier)
    expect(c1).toBe(c2)
  })

  it('yields different challenges for different verifiers', async () => {
    const v1 = await generateCodeVerifier()
    const v2 = await generateCodeVerifier()
    const c1 = await generateCodeChallenge(v1)
    const c2 = await generateCodeChallenge(v2)
    expect(c1).not.toBe(c2)
  })
})
