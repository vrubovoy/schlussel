// Open-redirect guard: `return_to` drives a client-side redirect carrying a
// one-time authorization code, so its origin must be checked against a
// runtime allowlist before it's ever used. There is no server in this
// loop to do the check instead.
import { runtimeConfig } from './runtimeConfig'

const ALLOWED_ORIGINS = runtimeConfig.allowedReturnOrigins

export type ReturnToResult =
  | { present: false }
  | { present: true; valid: true; url: string }
  | { present: true; valid: false; url: string }

export function readReturnTo(search: string = window.location.search): ReturnToResult {
  const params = new URLSearchParams(search)
  const returnTo = params.get('return_to')
  if (!returnTo) return { present: false }

  try {
    const parsed = new URL(returnTo)
    if (ALLOWED_ORIGINS.includes(parsed.origin)) {
      return { present: true, valid: true, url: returnTo }
    }
    return { present: true, valid: false, url: returnTo }
  } catch {
    return { present: true, valid: false, url: returnTo }
  }
}

export type CodeChallengeResult =
  | { present: false }
  | { present: true; codeChallenge: string }

// PKCE: the caller supplies code_challenge/code_challenge_method (S256
// only - "plain" is not supported) instead of ever handling the real
// token here. Missing or using an unsupported method is treated the same
// as absent, since there is nothing safe to do with it otherwise.
export function readCodeChallenge(search: string = window.location.search): CodeChallengeResult {
  const params = new URLSearchParams(search)
  const codeChallenge = params.get('code_challenge')
  const method = params.get('code_challenge_method')
  if (!codeChallenge || method !== 'S256') return { present: false }
  return { present: true, codeChallenge }
}

// Read from the URL fragment, not a query param - a fragment is never
// sent in the HTTP request line, so it never touches Caddy's access logs
// or a Referer header the way `?invite=...` would. RegisterPage strips it
// from the visible URL via history.replaceState right after reading it.
export function readInviteCode(hash: string = window.location.hash): string {
  if (!hash.startsWith('#')) return ''
  const params = new URLSearchParams(hash.slice(1))
  return params.get('invite') ?? ''
}

export function redirectWithCode(returnTo: string, code: string) {
  const separator = returnTo.includes('?') ? '&' : '?'
  window.location.href = `${returnTo}${separator}code=${encodeURIComponent(code)}`
}

// Where an unguided visitor (no return_to at all) gets sent instead of ever
// seeing the login/register form - this is what makes these pages
// unreachable by typing their URL directly; they only render when an
// external redirect supplied a valid return_to.
export const DEFAULT_APP_URL = runtimeConfig.defaultAppUrl

export function redirectToDefaultApp() {
  window.location.href = DEFAULT_APP_URL
}

// Carries return_to AND the PKCE code_challenge/code_challenge_method
// forward to the sibling login/register page - both are required for that
// page's own guard to render a form at all, so dropping either here would
// silently break the cross-navigation link mid-flow.
export function withReturnTo(path: string, search: string = window.location.search): string {
  const params = new URLSearchParams(search)
  const returnTo = params.get('return_to')
  if (!returnTo) return path

  const forwarded = new URLSearchParams({ return_to: returnTo })
  const codeChallenge = params.get('code_challenge')
  const codeChallengeMethod = params.get('code_challenge_method')
  if (codeChallenge) forwarded.set('code_challenge', codeChallenge)
  if (codeChallengeMethod) forwarded.set('code_challenge_method', codeChallengeMethod)

  return `${path}?${forwarded.toString()}`
}
