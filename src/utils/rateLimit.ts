// In-memory failed-login throttle for POST /auth/login - bcrypt (cost 12)
// already slows down each individual guess, but nothing previously bounded
// the total number of attempts. Scoped to /login specifically: invite
// codes and PKCE codes are 192/256 bits of entropy and unguessable
// regardless, so a limiter only meaningfully matters for password
// guessing. A single self-hosted instance doesn't need a shared store
// (Redis etc.) - this resets on process restart, which is an acceptable
// trade-off for what this guards against.
//
// Keyed by IP and counts failures only (resets on a successful login), so
// normal use - including a legitimate user simply logging in often - never
// trips it; only repeated wrong passwords from the same source do.
const WINDOW_MS = 15 * 60 * 1000
const MAX_FAILURES = 20

interface Bucket {
  failures: number
  windowStart: number
}

const buckets = new Map<string, Bucket>()

function isExpired(bucket: Bucket, now: number): boolean {
  return now - bucket.windowStart > WINDOW_MS
}

export function isLoginRateLimited(key: string): boolean {
  const bucket = buckets.get(key)
  if (!bucket) return false
  if (isExpired(bucket, Date.now())) {
    buckets.delete(key)
    return false
  }
  return bucket.failures >= MAX_FAILURES
}

export function recordLoginFailure(key: string): void {
  const now = Date.now()
  const bucket = buckets.get(key)
  if (!bucket || isExpired(bucket, now)) {
    buckets.set(key, { failures: 1, windowStart: now })
  } else {
    bucket.failures += 1
  }
}

export function recordLoginSuccess(key: string): void {
  buckets.delete(key)
}
