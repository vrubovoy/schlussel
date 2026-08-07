const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MAX_TIMER_VALUE = 2_147_483_647

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function secret(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name)
  if (Buffer.byteLength(value) < 32) throw new Error(`${name} must be at least 32 bytes`)
  return value
}

function keyId(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name)
  if (!KEY_ID_PATTERN.test(value)) {
    throw new Error(`${name} must contain only letters, numbers, dot, underscore, or hyphen`)
  }
  return value
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]
  const value = raw == null || raw === '' ? fallback : Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_VALUE) {
    throw new Error(`${name} must be a positive integer no greater than ${MAX_TIMER_VALUE}`)
  }
  return value
}

function serviceBaseUrl(env: NodeJS.ProcessEnv): string {
  const raw = env['GLOCKE_BASE_URL'] ?? 'http://glocke-backend:3004'
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('GLOCKE_BASE_URL must be a valid HTTP(S) origin')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search ||
    url.hash
  ) {
    throw new Error('GLOCKE_BASE_URL must be a valid HTTP(S) origin')
  }
  return url.origin
}

export interface NotificationConfig {
  glockeBaseUrl: string
  outboundKeyId: string
  outboundSecret: string
  inboundKeyId: string
  inboundSecret: string
  signatureMaxSkewSeconds: number
  dispatchIntervalMs: number
  leaseMs: number
  fetchTimeoutMs: number
  workerStopTimeoutMs: number
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
}

export function loadNotificationConfig(env: NodeJS.ProcessEnv = process.env): NotificationConfig {
  const leaseMs = positiveInteger(env, 'GLOCKE_OUTBOX_LEASE_MS', 30_000)
  const fetchTimeoutMs = positiveInteger(env, 'GLOCKE_FETCH_TIMEOUT_MS', 10_000)
  const baseDelayMs = positiveInteger(env, 'GLOCKE_RETRY_BASE_DELAY_MS', 1_000)
  const maxDelayMs = positiveInteger(env, 'GLOCKE_RETRY_MAX_DELAY_MS', 15 * 60_000)
  const outboundSecret = secret(env, 'SCHLUSSEL_TO_GLOCKE_HMAC_SECRET')
  const inboundSecret = secret(env, 'GLOCKE_TO_SCHLUSSEL_HMAC_SECRET')
  if (fetchTimeoutMs >= leaseMs) throw new Error('GLOCKE_FETCH_TIMEOUT_MS must be shorter than GLOCKE_OUTBOX_LEASE_MS')
  if (maxDelayMs < baseDelayMs) throw new Error('GLOCKE_RETRY_MAX_DELAY_MS must be at least GLOCKE_RETRY_BASE_DELAY_MS')
  if (outboundSecret === inboundSecret) throw new Error('Directional HMAC secrets must be distinct')

  return {
    glockeBaseUrl: serviceBaseUrl(env),
    outboundKeyId: keyId(env, 'SCHLUSSEL_TO_GLOCKE_HMAC_KEY_ID'),
    outboundSecret,
    inboundKeyId: keyId(env, 'GLOCKE_TO_SCHLUSSEL_HMAC_KEY_ID'),
    inboundSecret,
    signatureMaxSkewSeconds: positiveInteger(env, 'GLOCKE_SIGNATURE_MAX_SKEW_SECONDS', 300),
    dispatchIntervalMs: positiveInteger(env, 'GLOCKE_DISPATCH_INTERVAL_MS', 1_000),
    leaseMs,
    fetchTimeoutMs,
    workerStopTimeoutMs: positiveInteger(env, 'GLOCKE_WORKER_STOP_TIMEOUT_MS', 5_000),
    maxAttempts: positiveInteger(env, 'GLOCKE_MAX_ATTEMPTS', 8),
    baseDelayMs,
    maxDelayMs,
  }
}
