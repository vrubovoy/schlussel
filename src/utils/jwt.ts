import { SignJWT, jwtVerify } from 'jose'
import { randomUUID } from 'node:crypto'
import { getPrivateKey, getPublicKey } from './keys.js'

export interface JwtPayload {
  sub: string
  email: string
  name: string
  role: 'admin' | 'user'
  // Embedded so every consuming service can actually render with these
  // preferences (tafel's calendar week-start, date/time formatting
  // everywhere) by reading the already-verified token, rather than each
  // service making a live call back to schlussel per request - the same
  // "verify once, no callback" shape every other claim here already
  // follows. Deliberately NOT every profile field: avatar/notification
  // prefs/connected accounts have no other service that needs them, so
  // they stay schlussel-only rather than bloating every token. Refreshes
  // automatically whenever the access token itself refreshes (every 15
  // minutes at most - see ACCESS_TOKEN_TTL), so a changed preference
  // takes effect quickly without needing to force a fresh login.
  weekStart?: 'monday' | 'sunday' | null
  dateFormat?: 'dmy' | 'mdy' | 'ymd' | null
  timezone?: string | null
}

export interface VerifiedTokenPayload {
  sub: string
  exp: number
  tokenUse: string | null
  email?: string
  name?: string
  role?: 'admin' | 'user'
  weekStart?: 'monday' | 'sunday' | null
  dateFormat?: 'dmy' | 'mdy' | 'ymd' | null
  timezone?: string | null
  jti?: string
  jobId?: string
  scope?: string
  audience?: string | string[]
}

const ACCESS_TOKEN_TTL = '15m'
const REFRESH_TOKEN_TTL = '7d'
const ISSUER = process.env['JWT_ISSUER'] ?? 'schlussel'

export async function signAccessToken(payload: JwtPayload): Promise<string> {
  return new SignJWT({
    token_use: 'access',
    email: payload.email,
    name: payload.name,
    role: payload.role,
    weekStart: payload.weekStart ?? null,
    dateFormat: payload.dateFormat ?? null,
    timezone: payload.timezone ?? null,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'schloss-1' })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setExpirationTime(ACCESS_TOKEN_TTL)
    .sign(getPrivateKey())
}

export async function signRefreshToken(userId: string): Promise<string> {
  return new SignJWT({ jti: randomUUID(), token_use: 'refresh' })
    .setProtectedHeader({ alg: 'RS256', kid: 'schloss-1' })
    .setSubject(userId)
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setExpirationTime(REFRESH_TOKEN_TTL)
    .sign(getPrivateKey())
}

export async function signExportToken(
  userId: string,
  service: string,
  jobId: string,
  now: Date = new Date(),
): Promise<string> {
  const issuedAt = Math.floor(now.getTime() / 1_000)
  return new SignJWT({
    token_use: 'export',
    scope: 'data:export',
    job_id: jobId,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'schloss-1' })
    .setSubject(userId)
    .setAudience(`hof-service:${service}`)
    .setJti(randomUUID())
    .setIssuedAt(issuedAt)
    .setIssuer(ISSUER)
    .setExpirationTime(issuedAt + 5 * 60)
    .sign(getPrivateKey())
}

export async function verifyToken(token: string): Promise<VerifiedTokenPayload> {
  const { payload } = await jwtVerify(token, getPublicKey(), {
    algorithms: ['RS256'],
    issuer: ISSUER,
    requiredClaims: ['sub', 'exp'],
  })
  if (typeof payload.sub !== 'string' || !payload.sub || typeof payload.exp !== 'number') {
    throw new Error('Invalid token claims')
  }
  const tokenUse = payload['token_use']
  return {
    sub: payload.sub,
    exp: payload.exp,
    tokenUse: typeof tokenUse === 'string' ? tokenUse : null,
    ...(typeof payload['email'] === 'string' ? { email: payload['email'] } : {}),
    ...(typeof payload['name'] === 'string' ? { name: payload['name'] } : {}),
    ...(payload['role'] === 'admin' || payload['role'] === 'user' ? { role: payload['role'] } : {}),
    ...(payload['weekStart'] === 'monday' || payload['weekStart'] === 'sunday' || payload['weekStart'] === null
      ? { weekStart: payload['weekStart'] } : {}),
    ...(payload['dateFormat'] === 'dmy' || payload['dateFormat'] === 'mdy' || payload['dateFormat'] === 'ymd' || payload['dateFormat'] === null
      ? { dateFormat: payload['dateFormat'] } : {}),
    ...(typeof payload['timezone'] === 'string' || payload['timezone'] === null ? { timezone: payload['timezone'] } : {}),
    ...(typeof payload.jti === 'string' ? { jti: payload.jti } : {}),
    ...(typeof payload['job_id'] === 'string' ? { jobId: payload['job_id'] } : {}),
    ...(typeof payload['scope'] === 'string' ? { scope: payload['scope'] } : {}),
    ...(typeof payload.aud === 'string' || Array.isArray(payload.aud) ? { audience: payload.aud } : {}),
  }
}

export async function verifyAccessToken(token: string): Promise<JwtPayload & { exp: number }> {
  const payload = await verifyToken(token)
  const legacy = payload.tokenUse === null
  if (
    (payload.tokenUse !== 'access' && !legacy) ||
    typeof payload.email !== 'string' ||
    typeof payload.name !== 'string' ||
    (payload.role !== 'admin' && payload.role !== 'user') ||
    payload.jobId !== undefined ||
    payload.scope !== undefined ||
    payload.audience !== undefined
  ) {
    throw new Error('Invalid access token')
  }
  return {
    sub: payload.sub,
    email: payload.email,
    name: payload.name,
    role: payload.role,
    weekStart: payload.weekStart ?? null,
    dateFormat: payload.dateFormat ?? null,
    timezone: payload.timezone ?? null,
    exp: payload.exp,
  }
}

export function isRefreshTokenPayload(payload: VerifiedTokenPayload): boolean {
  if (payload.tokenUse === 'refresh') return typeof payload.jti === 'string'
  return payload.tokenUse === null &&
    typeof payload.jti === 'string' &&
    payload.email === undefined &&
    payload.name === undefined &&
    payload.role === undefined &&
    payload.jobId === undefined &&
    payload.scope === undefined &&
    payload.audience === undefined
}
