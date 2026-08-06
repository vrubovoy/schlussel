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

const ACCESS_TOKEN_TTL = '15m'
const REFRESH_TOKEN_TTL = '7d'
const ISSUER = process.env['JWT_ISSUER'] ?? 'schlussel'

export async function signAccessToken(payload: JwtPayload): Promise<string> {
  return new SignJWT({
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
  return new SignJWT({ jti: randomUUID() })
    .setProtectedHeader({ alg: 'RS256', kid: 'schloss-1' })
    .setSubject(userId)
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setExpirationTime(REFRESH_TOKEN_TTL)
    .sign(getPrivateKey())
}

export async function verifyToken(token: string): Promise<JwtPayload & { exp: number }> {
  const { payload } = await jwtVerify(token, getPublicKey(), { issuer: ISSUER })
  return {
    sub: payload.sub as string,
    email: payload['email'] as string,
    name: payload['name'] as string,
    role: payload['role'] as 'admin' | 'user',
    weekStart: payload['weekStart'] as 'monday' | 'sunday' | null,
    dateFormat: payload['dateFormat'] as 'dmy' | 'mdy' | 'ymd' | null,
    timezone: payload['timezone'] as string | null,
    exp: payload.exp as number,
  }
}
