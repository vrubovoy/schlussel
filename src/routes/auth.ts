import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq, lt, and, isNull, gt } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { db } from '../db/index.js'
import { users, refreshTokens, authCodes, invites, connectedAccounts, type User } from '../db/schema.js'
import { hashPassword, verifyPassword } from '../utils/password.js'
import { signAccessToken, signRefreshToken, verifyToken } from '../utils/jwt.js'
import { isLoginRateLimited, recordLoginFailure, recordLoginSuccess } from '../utils/rateLimit.js'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const REFRESH_TOKEN_MAX_AGE = 60 * 60 * 24 * 7 // 7 days in seconds
const COOKIE_NAME = 'schloss_refresh'
const AUTH_CODE_MAX_AGE = 60 // seconds

// Injected only by schlussel/frontend's own proxy (Caddyfile + vite dev config)
// on its /auth/* passthrough - every consumer app's own /auth/* proxy
// (kuvert, schloss) does NOT add this. Trust boundary: schlussel:4000 is
// never published outside the docker network (see docker-compose.yml), so
// this header can't be forged by anything but code we control.
const TRUSTED_ORIGIN_HEADER = 'x-schlussel-frontend'

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

// PKCE code_challenge is base64url(SHA256(code_verifier)) - always exactly
// 43 characters. code_verifier itself is 43-128 chars per RFC 7636.
const codeChallengeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)

export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  name: z.string().min(1).max(100),
  // Required unless this is the very first user on the platform (see the
  // handler below) - there's no admin yet to have issued one at that point.
  inviteCode: z.string().min(1).optional(),
})

export const loginSchema = z
  .object({
    email: z.string().email(),
    password: z.string(),
    codeChallenge: codeChallengeSchema.optional(),
    codeChallengeMethod: z.literal('S256').optional(),
  })
  .refine(
    (v) => (v.codeChallenge === undefined) === (v.codeChallengeMethod === undefined),
    { message: 'codeChallenge and codeChallengeMethod must be given together' },
  )

export const tokenSchema = z.object({
  code: z.string(),
  codeVerifier: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
})

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(128),
})

export const deleteAccountSchema = z.object({
  password: z.string().min(1),
})

export const nameSchema = z.object({
  name: z.string().min(1).max(100),
})

// Raw image bytes, not the base64 string's own length (~33% longer) - the
// cap that actually matters to a human is "how big is the picture".
export const MAX_AVATAR_BYTES = 400 * 1024

const DATA_URL_PATTERN = /^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/]+=*)$/

export const avatarSchema = z.object({
  avatarDataUrl: z.string().refine((value) => {
    const match = DATA_URL_PATTERN.exec(value)
    if (!match) return false
    const base64 = match[2]!
    // Exact byte count without actually decoding - each base64 char is
    // 6 bits, minus 1 byte per trailing '=' padding char.
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
    const bytes = (base64.length * 3) / 4 - padding
    return bytes <= MAX_AVATAR_BYTES
  }, { message: `Avatar must be a PNG/JPEG/WebP/GIF data URL under ${MAX_AVATAR_BYTES} bytes` }),
})

// All optional - PATCH /profile only ever touches whichever of these the
// caller actually sent, exactly like PATCH /name and the notes/tags
// pattern elsewhere on this platform. Explicit `null` clears a field
// back to "unset" (the frontend's own display default takes over); an
// absent key leaves it untouched.
export const profileUpdateSchema = z.object({
  timezone: z.string().max(100).nullable().optional(),
  dateFormat: z.enum(['dmy', 'mdy', 'ymd']).nullable().optional(),
  weekStart: z.enum(['monday', 'sunday']).nullable().optional(),
  language: z.enum(['ru', 'en']).nullable().optional(),
  notifyInApp: z.boolean().optional(),
  notifyBrowserPush: z.boolean().optional(),
  notifyTelegram: z.boolean().optional(),
  // 5 minutes to 30 days - below that isn't a usable session, above that
  // is just REFRESH_TOKEN_MAX_AGE (the platform default) with extra steps.
  sessionTimeoutMinutes: z.number().int().min(5).max(43200).nullable().optional(),
})

// Optional body for POST /refresh - lets schlussel's own login page check
// for an existing session before ever showing the credentials form (see
// the /refresh handler below). Every existing caller sends no body at
// all, so this must stay optional and not break that.
const refreshSchema = z
  .object({
    codeChallenge: codeChallengeSchema.optional(),
    codeChallengeMethod: z.literal('S256').optional(),
  })
  .refine(
    (v) => (v.codeChallenge === undefined) === (v.codeChallengeMethod === undefined),
    { message: 'codeChallenge and codeChallengeMethod must be given together' },
  )

interface RequestMeta {
  userAgent: string | null
  ipAddress: string | null
}

// Minimal shape covering both reading request headers and writing
// response headers - every real Hono context satisfies this; used
// instead of the full Hono type so these helpers stay easy to call from
// anywhere that has a context-like object (including tests).
type RequestResponseContext = {
  req: { header: (name: string) => string | undefined }
  header: (name: string, value: string) => void
}

// Captured only for display on the account settings page's active-sessions
// list - x-forwarded-for's first entry is the original client, reasonable
// behind the platform's own Caddy gateway (see tor/ and each service's own
// Caddyfile); absent for anything not proxied that way.
function requestMeta(c: { req: { header: (name: string) => string | undefined } }): RequestMeta {
  return {
    userAgent: c.req.header('user-agent') ?? null,
    ipAddress: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
  }
}

// Creates a new refresh token, stores it, and sets it as the httpOnly
// cookie - the session-establishing side effect shared by every path
// below that authenticates a user. Takes the full user row (not just an
// id) so a per-user sessionTimeoutMinutes preference (see profileUpdateSchema)
// can shorten this session's lifetime - it can only ever shorten, never
// extend past REFRESH_TOKEN_MAX_AGE, which stays the platform-wide ceiling.
async function establishSession(c: RequestResponseContext, user: User, meta: RequestMeta): Promise<void> {
  const refreshToken = await signRefreshToken(user.id)
  const maxAgeSeconds = user.sessionTimeoutMinutes != null
    ? Math.min(user.sessionTimeoutMinutes * 60, REFRESH_TOKEN_MAX_AGE)
    : REFRESH_TOKEN_MAX_AGE
  await db.insert(refreshTokens).values({
    id: createId(),
    userId: user.id,
    tokenHash: hashToken(refreshToken),
    userAgent: meta.userAgent,
    ipAddress: meta.ipAddress,
    expiresAt: new Date(Date.now() + maxAgeSeconds * 1000),
    createdAt: new Date(),
  })
  setCookieHeader(c, refreshToken)
}

// Issues a real access token plus, if `trusted`, a fresh session cookie -
// shared by the no-PKCE /login branch and the /token exchange, both gated
// on isTrustedOrigin since either can in principle be reached through a
// consumer app's own /auth/* proxy. Both hand the access token straight
// back in the response body regardless.
async function issueSession(c: RequestResponseContext, user: User, trusted: boolean) {
  const accessToken = await signAccessToken({
    sub: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
  })
  if (trusted) await establishSession(c, user, requestMeta(c))

  return {
    accessToken,
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
  }
}

// Issues a short-lived one-time PKCE code for a user - shared by the
// password-verified /login branch and the cookie-verified silent-reauth
// branch of /refresh below, so a token never has to travel through a
// redirect URL in either case.
async function issueAuthCode(userId: string, codeChallenge: string): Promise<string> {
  const code = randomBytes(32).toString('base64url')
  await db.insert(authCodes).values({
    id: createId(),
    userId,
    codeHash: hashToken(code),
    codeChallenge,
    expiresAt: new Date(Date.now() + AUTH_CODE_MAX_AGE * 1000),
    createdAt: new Date(),
  })
  return code
}

// Shared by /password, /account, and admin.ts's authenticateAdmin - all
// need "who is making this request", the same check /me already does
// inline. /me itself isn't refactored onto it, to avoid touching a
// working, already-tested code path for an unrelated change.
export async function authenticateBearer(c: { req: { header: (name: string) => string | undefined } }): Promise<User | null> {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return null
  try {
    const payload = await verifyToken(authHeader.slice(7))
    const user = await db.select().from(users).where(eq(users.id, payload.sub)).get()
    return user ?? null
  } catch {
    return null
  }
}

export const authRouter = new Hono()

// Marker used below to distinguish "invite redemption failed" from any
// other unexpected error thrown out of the transaction.
class InvalidInviteError extends Error {}

authRouter.post('/register', zValidator('json', registerSchema), async (c) => {
  const { email, password, name, inviteCode } = c.req.valid('json')

  const existing = await db.select().from(users).where(eq(users.email, email)).get()
  if (existing) {
    return c.json({ error: 'Email already registered' }, 409)
  }

  // First user becomes admin and bootstraps without an invite - there is
  // no admin yet to have issued one.
  const userCount = await db.select().from(users).all()
  const isFirstUser = userCount.length === 0
  const role: 'admin' | 'user' = isFirstUser ? 'admin' : 'user'

  if (!isFirstUser && !inviteCode) {
    return c.json({ error: 'Invite code required' }, 400)
  }

  const user = {
    id: createId(),
    email,
    passwordHash: await hashPassword(password),
    name,
    role,
    createdAt: new Date(),
  }

  try {
    // better-sqlite3 transactions are synchronous - hashing the password
    // above (real async work) happens before entering it, so nothing
    // inside this callback ever yields to the event loop. Combined with
    // the conditional `usedAt IS NULL` guard, this makes invite redemption
    // atomic: two concurrent requests racing the same code can never both
    // succeed, and if the invite turns out to be invalid the user insert
    // rolls back with it instead of creating an account for nothing.
    //
    // The user row is inserted FIRST, before the invite is marked used -
    // `invites.used_by_user_id` has a foreign key to `users.id`, and
    // foreign_keys=ON enforces it immediately (not deferred), so setting
    // usedByUserId to a not-yet-existing user id would fail every time.
    db.transaction((tx) => {
      tx.insert(users).values(user).run()
      if (!isFirstUser && inviteCode) {
        const now = new Date()
        const redeemed = tx
          .update(invites)
          .set({ usedAt: now, usedByUserId: user.id })
          .where(and(
            eq(invites.codeHash, hashToken(inviteCode)),
            isNull(invites.usedAt),
            isNull(invites.revokedAt),
            gt(invites.expiresAt, now),
          ))
          .run()
        if (redeemed.changes === 0) throw new InvalidInviteError()
      }
    })
  } catch (err) {
    if (err instanceof InvalidInviteError) {
      // Deliberately vague - don't tell a caller whether the code was
      // wrong, expired, revoked, or already used.
      return c.json({ error: 'Invalid or expired invite code' }, 400)
    }
    throw err
  }

  return c.json({ id: user.id, email: user.email, name: user.name, role: user.role }, 201)
})

authRouter.post('/login', zValidator('json', loginSchema), async (c) => {
  const { email, password, codeChallenge } = c.req.valid('json')

  const rateLimitKey = requestMeta(c).ipAddress ?? 'unknown'
  if (isLoginRateLimited(rateLimitKey)) {
    return c.json({ error: 'Too many attempts - try again later' }, 429)
  }

  const user = await db.select().from(users).where(eq(users.email, email)).get()
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    recordLoginFailure(rateLimitKey)
    return c.json({ error: 'Invalid credentials' }, 401)
  }
  recordLoginSuccess(rateLimitKey)

  // PKCE handoff: issue a short-lived one-time code instead of a real
  // token, so the token itself never has to travel through a URL - the
  // caller redeems it at POST /auth/token with the matching verifier.
  // Also establishes a real session here, gated by isTrustedOrigin: this
  // endpoint should only ever be called from schlussel's own hosted login
  // page (never proxied through another service's origin), so the cookie
  // lands on schlussel's own origin and stays there - no cross-subdomain
  // Domain attribute needed. That's what lets the silent-reauth branch of
  // /refresh below skip the credentials form entirely the next time any
  // app redirects here.
  if (codeChallenge) {
    if (isTrustedOrigin(c)) await establishSession(c, user, requestMeta(c))
    const code = await issueAuthCode(user.id, codeChallenge)
    return c.json({ code })
  }

  // No-PKCE branch: intended to only ever be reached same-origin, but
  // codeChallenge is optional here, so nothing stops a caller reaching it
  // through a consumer app's own /auth/* proxy - gate the cookie the same
  // way the PKCE branch above and /token below already do, rather than
  // assuming same-origin.
  return c.json(await issueSession(c, user, isTrustedOrigin(c)))
})

authRouter.post('/token', zValidator('json', tokenSchema), async (c) => {
  const { code, codeVerifier } = c.req.valid('json')

  // Lazy cleanup of expired codes - no cron, same as elsewhere on the
  // platform; piggybacks on a request that's already touching this table.
  await db.delete(authCodes).where(lt(authCodes.expiresAt, new Date()))

  const codeHash = hashToken(code)
  const stored = await db.select().from(authCodes).where(eq(authCodes.codeHash, codeHash)).get()
  if (!stored) return c.json({ error: 'Invalid or expired code' }, 400)

  // Single-use: delete before validating further, so a second concurrent
  // redemption attempt with the same code always finds nothing.
  await db.delete(authCodes).where(eq(authCodes.id, stored.id))

  const computedChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
  const a = Buffer.from(computedChallenge)
  const b = Buffer.from(stored.codeChallenge)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return c.json({ error: 'Invalid or expired code' }, 400)
  }

  const user = await db.select().from(users).where(eq(users.id, stored.userId)).get()
  if (!user) return c.json({ error: 'Invalid or expired code' }, 400)

  return c.json(await issueSession(c, user, isTrustedOrigin(c)))
})

authRouter.post('/refresh', async (c) => {
  const refreshToken = getCookie(c)
  if (!refreshToken) return c.json({ error: 'No refresh token' }, 401)

  let payload: Awaited<ReturnType<typeof verifyToken>>
  try {
    payload = await verifyToken(refreshToken)
  } catch {
    return c.json({ error: 'Invalid refresh token' }, 401)
  }

  const tokenHash = hashToken(refreshToken)
  const stored = await db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, tokenHash))
    .get()

  if (!stored || stored.expiresAt < new Date()) {
    return c.json({ error: 'Refresh token expired or not found' }, 401)
  }

  const user = await db.select().from(users).where(eq(users.id, payload.sub)).get()
  if (!user) return c.json({ error: 'User not found' }, 401)

  // Optional silent-reauth: schlussel's own login page calls this with a
  // codeChallenge to check for an existing session (this same cookie,
  // always same-origin there) before ever showing the credentials form.
  // Every other existing caller sends no body, which parses to {} here
  // and falls through to today's plain-refresh behavior unchanged.
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    body = {}
  }
  const parsed = refreshSchema.safeParse(body)
  if (!parsed.success) return c.json({ error: 'Invalid request' }, 400)

  // Rotate refresh token - deleted unconditionally, re-issued only if
  // trusted (see isTrustedOrigin). An untrusted caller (a consumer app's
  // own proxied /auth/refresh, polling to keep its local state fresh)
  // still gets a valid access token back for whatever cookie it already
  // had, but that cookie is not renewed - it quietly stops working the
  // moment its now-deleted DB row is looked up again, instead of being
  // rotated forever.
  await db.delete(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash))
  const trusted = isTrustedOrigin(c)

  if (parsed.data.codeChallenge) {
    if (trusted) await establishSession(c, user, requestMeta(c))
    const code = await issueAuthCode(user.id, parsed.data.codeChallenge)
    return c.json({ code })
  }

  const newAccessToken = await signAccessToken({
    sub: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
  })
  if (trusted) await establishSession(c, user, requestMeta(c))

  return c.json({ accessToken: newAccessToken })
})

authRouter.post('/logout', async (c) => {
  const refreshToken = getCookie(c)
  if (refreshToken) {
    const tokenHash = hashToken(refreshToken)
    await db.delete(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash))
  }
  clearCookie(c)
  return c.json({ ok: true })
})

authRouter.get('/me', async (c) => {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return c.json({ error: 'Unauthorized' }, 401)

  try {
    const payload = await verifyToken(authHeader.slice(7))
    const user = await db.select().from(users).where(eq(users.id, payload.sub)).get()
    if (!user) return c.json({ error: 'User not found' }, 404)
    return c.json({ id: user.id, email: user.email, name: user.name, role: user.role })
  } catch {
    return c.json({ error: 'Invalid token' }, 401)
  }
})

// Unified account settings - shared by every consumer app (see
// schlussel/frontend's AccountPage), not a kuvert/schloss-specific concept.
// Only ever called same-origin from that page, so - like the no-PKCE
// branch of /login above - always trusted: safe to unconditionally set a
// fresh session cookie here without an isTrustedOrigin gate.
authRouter.patch('/password', zValidator('json', changePasswordSchema), async (c) => {
  const user = await authenticateBearer(c)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  const { currentPassword, newPassword } = c.req.valid('json')
  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    return c.json({ error: 'Invalid current password' }, 401)
  }

  await db.update(users).set({ passwordHash: await hashPassword(newPassword) }).where(eq(users.id, user.id))

  // A changed password invalidates every other session on every service -
  // standard practice for "someone else might have had this password".
  // Re-establish only this browser's own session right after, so the
  // account page that just made this request doesn't immediately find
  // itself logged out too.
  await db.delete(refreshTokens).where(eq(refreshTokens.userId, user.id))
  await establishSession(c, user, requestMeta(c))

  return c.json({ ok: true })
})

authRouter.delete('/account', zValidator('json', deleteAccountSchema), async (c) => {
  const user = await authenticateBearer(c)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  const { password } = c.req.valid('json')
  if (!(await verifyPassword(password, user.passwordHash))) {
    return c.json({ error: 'Invalid password' }, 401)
  }

  // Registration is invite-gated and only an admin can issue invites - if
  // this is the sole remaining admin, deleting their own account would be
  // a deterministic, unrecoverable lockout (no one left able to ever
  // create a new admin again). The admin-mediated paths in admin.ts
  // already guard against this same outcome; self-service deletion needs
  // the identical guard. Checked and deleted inside one synchronous
  // transaction so a concurrent request can't slip through between the
  // count and the delete (matches PATCH /admin/users/:id/role and
  // DELETE /admin/users/:id's own guard).
  const orphaned = db.transaction((tx) => {
    if (user.role === 'admin') {
      const admins = tx.select().from(users).where(eq(users.role, 'admin')).all()
      if (admins.length <= 1) return true
    }
    // Cascades refresh_tokens and auth_codes (see schema.ts's onDelete:
    // 'cascade' on both, and foreign_keys=ON in db/index.ts) - no manual
    // cleanup needed here. Other services' own local copies of this
    // user's id are left as-is; without a valid session they can never be
    // issued a new token again, which is what actually locks them out.
    tx.delete(users).where(eq(users.id, user.id)).run()
    return false
  })
  if (orphaned) {
    return c.json({ error: 'Cannot delete the last remaining admin - promote another user first' }, 409)
  }
  clearCookie(c)

  return c.json({ ok: true })
})

authRouter.patch('/name', zValidator('json', nameSchema), async (c) => {
  const user = await authenticateBearer(c)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  const { name } = c.req.valid('json')
  await db.update(users).set({ name }).where(eq(users.id, user.id))

  return c.json({ id: user.id, email: user.email, name, role: user.role })
})

// The full extended profile - GET /me stays the small {id,email,name,role}
// identity shape every consumer app's own auth flow already expects
// unchanged; this is the account settings page's own richer read, kept
// separate so growing it further never touches that shared shape.
function profileJson(user: User) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    avatarDataUrl: user.avatarDataUrl,
    timezone: user.timezone,
    dateFormat: user.dateFormat,
    weekStart: user.weekStart,
    language: user.language,
    notifyInApp: user.notifyInApp,
    notifyBrowserPush: user.notifyBrowserPush,
    notifyTelegram: user.notifyTelegram,
    sessionTimeoutMinutes: user.sessionTimeoutMinutes,
  }
}

authRouter.get('/profile', async (c) => {
  const user = await authenticateBearer(c)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  return c.json(profileJson(user))
})

authRouter.patch('/profile', zValidator('json', profileUpdateSchema), async (c) => {
  const user = await authenticateBearer(c)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  const data = c.req.valid('json')
  await db.update(users).set(data).where(eq(users.id, user.id))

  // Re-read rather than hand-merging user + data: every field in data is
  // optional (only the keys the caller actually sent are present), so a
  // merged object can't be typed as a real User without either an unsafe
  // cast or re-deriving exactly what the database now holds anyway.
  const updated = await db.select().from(users).where(eq(users.id, user.id)).get()
  return c.json(profileJson(updated!))
})

authRouter.put('/avatar', zValidator('json', avatarSchema), async (c) => {
  const user = await authenticateBearer(c)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  const { avatarDataUrl } = c.req.valid('json')
  await db.update(users).set({ avatarDataUrl }).where(eq(users.id, user.id))

  return c.json(profileJson({ ...user, avatarDataUrl }))
})

authRouter.delete('/avatar', async (c) => {
  const user = await authenticateBearer(c)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  await db.update(users).set({ avatarDataUrl: null }).where(eq(users.id, user.id))

  return c.json(profileJson({ ...user, avatarDataUrl: null }))
})

// Always empty in practice today - there's no Telegram bot (or any other
// provider) to actually hand a connect flow off to yet, so nothing ever
// inserts a row here. Exposed anyway so the account page reads real
// (currently always-empty) data instead of a hardcoded placeholder, and
// so the eventual connect flow only needs to add a POST here, not build
// this list-and-disconnect half from scratch at the same time.
authRouter.get('/connected-accounts', async (c) => {
  const user = await authenticateBearer(c)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  const accounts = await db.select().from(connectedAccounts).where(eq(connectedAccounts.userId, user.id))
  return c.json(accounts.map((a) => ({
    id: a.id, provider: a.provider, externalUsername: a.externalUsername, connectedAt: a.connectedAt,
  })))
})

authRouter.delete('/connected-accounts/:id', async (c) => {
  const user = await authenticateBearer(c)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  const { id } = c.req.param()
  const existing = await db.select().from(connectedAccounts)
    .where(and(eq(connectedAccounts.id, id), eq(connectedAccounts.userId, user.id))).get()
  if (!existing) return c.json({ error: 'Not found' }, 404)

  await db.delete(connectedAccounts).where(eq(connectedAccounts.id, id))
  return c.json({ ok: true })
})

// Exports this account's own Schlüssel data (profile fields + session
// metadata) as a downloadable JSON blob. Scoped to what this service
// owns, not a platform-wide export - kuvert/tafel/zettel each hold their
// own data (transactions, tasks, notes) that this can't see or reach;
// a real cross-service export needs those services' own cooperation and
// is future work, not something to fake here by only covering the one
// service that happens to already be reachable.
authRouter.get('/export', async (c) => {
  const user = await authenticateBearer(c)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  const sessions = await db.select().from(refreshTokens).where(eq(refreshTokens.userId, user.id))
  const accounts = await db.select().from(connectedAccounts).where(eq(connectedAccounts.userId, user.id))

  return c.json({
    exportedAt: new Date().toISOString(),
    scope: 'schlussel-account-only',
    profile: profileJson(user),
    createdAt: user.createdAt,
    sessions: sessions.map((s) => ({
      userAgent: s.userAgent, ipAddress: s.ipAddress, createdAt: s.createdAt, expiresAt: s.expiresAt,
    })),
    connectedAccounts: accounts.map((a) => ({
      provider: a.provider, externalUsername: a.externalUsername, connectedAt: a.connectedAt,
    })),
  })
})

// Active-sessions list for the account settings page. `current` is
// derived by hashing this request's own cookie (if any) and comparing -
// the same mechanism /refresh already uses to look a session up.
authRouter.get('/sessions', async (c) => {
  const user = await authenticateBearer(c)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  // Lazy cleanup, same pattern as expired auth_codes at POST /token -
  // scoped to this user so a busy platform never does a full-table scan
  // just because one person opened their sessions list.
  await db.delete(refreshTokens).where(and(eq(refreshTokens.userId, user.id), lt(refreshTokens.expiresAt, new Date())))

  const currentCookie = getCookie(c)
  const currentHash = currentCookie ? hashToken(currentCookie) : null

  const sessions = await db.select().from(refreshTokens).where(eq(refreshTokens.userId, user.id)).all()
  sessions.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())

  return c.json(
    sessions.map((s) => ({
      id: s.id,
      userAgent: s.userAgent,
      ipAddress: s.ipAddress,
      createdAt: s.createdAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      current: s.tokenHash === currentHash,
    })),
  )
})

authRouter.delete('/sessions/:id', async (c) => {
  const user = await authenticateBearer(c)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  const id = c.req.param('id')
  // Scoped to userId - not just "delete by id" - so this can't be used to
  // probe or revoke another user's session by guessing an id.
  const session = await db.select().from(refreshTokens).where(and(eq(refreshTokens.id, id), eq(refreshTokens.userId, user.id))).get()
  if (!session) return c.json({ error: 'Session not found' }, 404)

  await db.delete(refreshTokens).where(eq(refreshTokens.id, id))

  const currentCookie = getCookie(c)
  if (currentCookie && hashToken(currentCookie) === session.tokenHash) clearCookie(c)

  return c.json({ ok: true })
})

// "Выйти на всех устройствах" - unlike changing the password, this does
// NOT re-establish a fresh session for the calling browser. Logging out
// everywhere is supposed to mean everywhere, including here.
authRouter.delete('/sessions', async (c) => {
  const user = await authenticateBearer(c)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  await db.delete(refreshTokens).where(eq(refreshTokens.userId, user.id))
  clearCookie(c)

  return c.json({ ok: true })
})

// Helpers — cookie management without external deps
function setCookieHeader(c: Parameters<typeof clearCookie>[0], token: string) {
  c.header(
    'Set-Cookie',
    `${COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${REFRESH_TOKEN_MAX_AGE}; SameSite=Strict; Secure`,
  )
}

function clearCookie(c: { header: (name: string, value: string) => void }) {
  c.header(
    'Set-Cookie',
    `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict; Secure`,
  )
}

function getCookie(c: { req: { header: (name: string) => string | undefined } }): string | null {
  const cookieHeader = c.req.header('cookie')
  if (!cookieHeader) return null
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`))
  return match?.[1] ?? null
}

function isTrustedOrigin(c: { req: { header: (name: string) => string | undefined } }): boolean {
  return c.req.header(TRUSTED_ORIGIN_HEADER) === '1'
}
