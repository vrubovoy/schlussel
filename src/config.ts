import { readFileSync, statSync } from 'node:fs'

const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MAX_TIMER_VALUE = 2_147_483_647
const MAX_SECRET_FILE_BYTES = 64 * 1024

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

export interface SecretFileAccess {
  stat(path: string): { isFile(): boolean; size: number }
  read(path: string): Buffer
}

const defaultSecretFileAccess: SecretFileAccess = {
  stat: statSync,
  read: readFileSync,
}

export function resolveSecret(
  env: NodeJS.ProcessEnv,
  name: 'SCHLUSSEL_TO_GLOCKE_HMAC_SECRET' | 'GLOCKE_TO_SCHLUSSEL_HMAC_SECRET',
  files: SecretFileAccess = defaultSecretFileAccess,
): string {
  const direct = env[name] || undefined
  const fileName = `${name}_FILE`
  const path = env[fileName] || undefined
  if (direct && path) throw new Error(`${name} and ${fileName} are mutually exclusive`)

  let value = direct
  if (path) {
    if (path.trim() !== path) throw new Error(`${fileName} must not have surrounding whitespace`)
    let bytes: Buffer
    try {
      const metadata = files.stat(path)
      if (!metadata.isFile()) throw new Error('not a regular file')
      if (metadata.size > MAX_SECRET_FILE_BYTES) throw new Error('file is too large')
      bytes = files.read(path)
    } catch {
      throw new Error(`${fileName} must reference a readable regular file no larger than 64 KiB`)
    }
    if (bytes.length > MAX_SECRET_FILE_BYTES) {
      throw new Error(`${fileName} must reference a readable regular file no larger than 64 KiB`)
    }
    try {
      value = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw new Error(`${fileName} must contain valid UTF-8`)
    }
    if (value.endsWith('\r\n')) value = value.slice(0, -2)
    else if (value.endsWith('\n')) value = value.slice(0, -1)
    if (!value || value.includes('\0')) throw new Error(`${fileName} must contain a non-empty secret without NUL bytes`)
  }

  if (!value) throw new Error(`${name} or ${fileName} is required`)
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

function nonnegativeInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]
  const value = raw == null || raw === '' ? fallback : Number(raw)
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TIMER_VALUE) {
    throw new Error(`${name} must be a nonnegative integer no greater than ${MAX_TIMER_VALUE}`)
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

export function loadNotificationConfig(
  env: NodeJS.ProcessEnv = process.env,
  files: SecretFileAccess = defaultSecretFileAccess,
): NotificationConfig | null {
  const enabled = env['GLOCKE_ENABLED'] === 'true'
  if (!enabled) return null
  const leaseMs = positiveInteger(env, 'GLOCKE_OUTBOX_LEASE_MS', 30_000)
  const fetchTimeoutMs = positiveInteger(env, 'GLOCKE_FETCH_TIMEOUT_MS', 10_000)
  const baseDelayMs = positiveInteger(env, 'GLOCKE_RETRY_BASE_DELAY_MS', 1_000)
  const maxDelayMs = positiveInteger(env, 'GLOCKE_RETRY_MAX_DELAY_MS', 15 * 60_000)
  const outboundSecret = resolveSecret(env, 'SCHLUSSEL_TO_GLOCKE_HMAC_SECRET', files)
  const inboundSecret = resolveSecret(env, 'GLOCKE_TO_SCHLUSSEL_HMAC_SECRET', files)
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

export interface ExportConfig {
  exportDir: string
  kuvertUrl: string | undefined
  tafelUrl: string | undefined
  zettelUrl: string | undefined
  glockeUrl: string | undefined
  schrankUrl: string | undefined
  heroldUrl: string | undefined
  dispatchIntervalMs: number
  requestTimeoutMs: number
  leaseMs: number
  workerStopTimeoutMs: number
  maxResponseBytes: number
  maxAggregateBytes: number
  maxConcurrency: number
  artifactTtlMs: number
  userCooldownMs: number
  maxRetainedJobsPerUser: number
  maxRetainedArtifactBytesPerUser: number
  storageQuotaBytes: number
  minFreeBytes: number
}

// Unset means this service isn't enabled in this deployment - not an error,
// and not a reason to fall back to an internal Compose hostname that may not
// exist. See ExportConfig/createExportServices for how an absent URL keeps
// that service out of the dispatch registry entirely.
function exportServiceUrl(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name]
  if (raw === undefined || raw === '') return undefined
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${name} must be a valid internal HTTP(S) export URL`)
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.pathname !== '/exports/me' ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must be a valid internal HTTP(S) URL ending in /exports/me`)
  }
  return url.toString()
}

export function loadExportConfig(env: NodeJS.ProcessEnv = process.env): ExportConfig {
  const requestTimeoutMs = positiveInteger(env, 'EXPORT_REQUEST_TIMEOUT_MS', 15_000)
  const leaseMs = positiveInteger(env, 'EXPORT_LEASE_MS', 120_000)
  const maxResponseBytes = positiveInteger(env, 'EXPORT_MAX_SERVICE_BYTES', 25 * 1024 * 1024)
  const maxAggregateBytes = positiveInteger(env, 'EXPORT_MAX_AGGREGATE_BYTES', 100 * 1024 * 1024)
  if (requestTimeoutMs >= leaseMs) throw new Error('EXPORT_REQUEST_TIMEOUT_MS must be shorter than EXPORT_LEASE_MS')
  if (maxAggregateBytes < maxResponseBytes) {
    throw new Error('EXPORT_MAX_AGGREGATE_BYTES must be at least EXPORT_MAX_SERVICE_BYTES')
  }
  const maxRetainedArtifactBytesPerUser = positiveInteger(
    env, 'EXPORT_MAX_RETAINED_ARTIFACT_BYTES_PER_USER', 300 * 1024 * 1024,
  )
  const storageQuotaBytes = positiveInteger(env, 'EXPORT_STORAGE_QUOTA_BYTES', 1024 * 1024 * 1024)
  const minFreeBytes = positiveInteger(env, 'EXPORT_MIN_FREE_BYTES', 256 * 1024 * 1024)
  if (maxRetainedArtifactBytesPerUser < maxAggregateBytes) {
    throw new Error('EXPORT_MAX_RETAINED_ARTIFACT_BYTES_PER_USER must be at least EXPORT_MAX_AGGREGATE_BYTES')
  }
  if (storageQuotaBytes < maxAggregateBytes * 2) {
    throw new Error('EXPORT_STORAGE_QUOTA_BYTES must be at least twice EXPORT_MAX_AGGREGATE_BYTES')
  }

  const exportDir = env['EXPORT_DIR'] ?? './data/exports'
  if (!exportDir.trim()) throw new Error('EXPORT_DIR must not be empty')
  return {
    exportDir,
    kuvertUrl: exportServiceUrl(env, 'KUVERT_EXPORT_URL'),
    tafelUrl: exportServiceUrl(env, 'TAFEL_EXPORT_URL'),
    zettelUrl: exportServiceUrl(env, 'ZETTEL_EXPORT_URL'),
    glockeUrl: exportServiceUrl(env, 'GLOCKE_EXPORT_URL'),
    schrankUrl: exportServiceUrl(env, 'SCHRANK_EXPORT_URL'),
    heroldUrl: exportServiceUrl(env, 'HEROLD_EXPORT_URL'),
    dispatchIntervalMs: positiveInteger(env, 'EXPORT_DISPATCH_INTERVAL_MS', 1_000),
    requestTimeoutMs,
    leaseMs,
    workerStopTimeoutMs: positiveInteger(env, 'EXPORT_WORKER_STOP_TIMEOUT_MS', 20_000),
    maxResponseBytes,
    maxAggregateBytes,
    maxConcurrency: positiveInteger(env, 'EXPORT_MAX_CONCURRENCY', 1),
    artifactTtlMs: positiveInteger(env, 'EXPORT_ARTIFACT_TTL_MS', 24 * 60 * 60_000),
    userCooldownMs: nonnegativeInteger(env, 'EXPORT_USER_COOLDOWN_MS', 60_000),
    maxRetainedJobsPerUser: positiveInteger(env, 'EXPORT_MAX_RETAINED_JOBS_PER_USER', 3),
    maxRetainedArtifactBytesPerUser,
    storageQuotaBytes,
    minFreeBytes,
  }
}

export interface DeletionConfig {
  // Absent means that service isn't enabled in this deployment - see
  // deletionServiceUrl and ENABLED_DELETION_SERVICES in services/deletionSaga.ts.
  serviceUrls: Readonly<Partial<Record<'kuvert' | 'tafel' | 'zettel' | 'glocke' | 'schrank' | 'herold', string>>>
  dispatchIntervalMs: number
  leaseMs: number
  fetchTimeoutMs: number
  workerStopTimeoutMs: number
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
}

function deletionServiceUrl(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name]
  if (raw === undefined || raw === '') return undefined
  let url: URL
  try { url = new URL(raw) } catch { throw new Error(`${name} must be a valid internal deletion URL`) }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password ||
    url.pathname !== '/internal/v1/account-deletions' || url.search || url.hash) {
    throw new Error(`${name} must end in /internal/v1/account-deletions`)
  }
  return url.toString()
}

export function loadDeletionConfig(env: NodeJS.ProcessEnv = process.env): DeletionConfig {
  const leaseMs = positiveInteger(env, 'DELETION_LEASE_MS', 30_000)
  const fetchTimeoutMs = positiveInteger(env, 'DELETION_FETCH_TIMEOUT_MS', 10_000)
  const baseDelayMs = positiveInteger(env, 'DELETION_RETRY_BASE_DELAY_MS', 1_000)
  const maxDelayMs = positiveInteger(env, 'DELETION_RETRY_MAX_DELAY_MS', 15 * 60_000)
  if (fetchTimeoutMs >= leaseMs) throw new Error('DELETION_FETCH_TIMEOUT_MS must be shorter than DELETION_LEASE_MS')
  if (maxDelayMs < baseDelayMs) throw new Error('DELETION_RETRY_MAX_DELAY_MS must be at least DELETION_RETRY_BASE_DELAY_MS')
  const candidateUrls: Record<'kuvert' | 'tafel' | 'zettel' | 'glocke' | 'schrank' | 'herold', string | undefined> = {
    kuvert: deletionServiceUrl(env, 'KUVERT_DELETION_URL'),
    tafel: deletionServiceUrl(env, 'TAFEL_DELETION_URL'),
    zettel: deletionServiceUrl(env, 'ZETTEL_DELETION_URL'),
    glocke: deletionServiceUrl(env, 'GLOCKE_DELETION_URL'),
    schrank: deletionServiceUrl(env, 'SCHRANK_DELETION_URL'),
    herold: deletionServiceUrl(env, 'HEROLD_DELETION_URL'),
  }
  return {
    serviceUrls: Object.fromEntries(
      Object.entries(candidateUrls).filter(([, url]) => url !== undefined),
    ) as DeletionConfig['serviceUrls'],
    dispatchIntervalMs: positiveInteger(env, 'DELETION_DISPATCH_INTERVAL_MS', 1_000),
    leaseMs,
    fetchTimeoutMs,
    workerStopTimeoutMs: positiveInteger(env, 'DELETION_WORKER_STOP_TIMEOUT_MS', 5_000),
    maxAttempts: positiveInteger(env, 'DELETION_MAX_ATTEMPTS', 8),
    baseDelayMs,
    maxDelayMs,
  }
}
