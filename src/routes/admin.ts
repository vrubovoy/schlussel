import { Hono, type Context } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { randomBytes } from 'node:crypto'
import { db } from '../db/index.js'
import { users, refreshTokens, invites } from '../db/schema.js'
import { verifyPassword } from '../utils/password.js'
import { authenticateBearer, hashToken } from './auth.js'

const DEFAULT_INVITE_TTL_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000

export const createInviteSchema = z.object({
  expiresInDays: z.number().int().min(1).max(30).optional(),
})

export const roleSchema = z.object({
  role: z.enum(['admin', 'user']),
})

export const adminDeleteSchema = z.object({
  password: z.string().min(1),
})

// Distinguishes "no/invalid bearer token" (401) from "valid token, wrong
// role" (403) - callers do
// `const auth = await authenticateAdmin(c); if ('response' in auth) return auth.response`.
// Exported so index.ts can gate the OpenAPI spec endpoint with the same
// check, without openapi.ts (which this file's schemas feed into) having
// to import back from here and create a cycle.
export async function authenticateAdmin(c: Context) {
  const user = await authenticateBearer(c)
  if (!user) return { response: c.json({ error: 'Unauthorized' }, 401) }
  if (user.role !== 'admin') return { response: c.json({ error: 'Forbidden' }, 403) }
  return { user }
}

// True if changing `targetUserId` to a non-admin role (or deleting it,
// when becomingNonAdmin reflects "this account stops being an admin")
// would leave the platform with zero admins.
async function wouldOrphanAdmins(targetUserId: string, becomingNonAdmin: boolean): Promise<boolean> {
  if (!becomingNonAdmin) return false
  const target = await db.select().from(users).where(eq(users.id, targetUserId)).get()
  if (!target || target.role !== 'admin') return false
  const admins = await db.select().from(users).where(eq(users.role, 'admin')).all()
  return admins.length <= 1
}

export const adminRouter = new Hono()

// ── Invites ──────────────────────────────────────────────────────────────

adminRouter.post('/invites', zValidator('json', createInviteSchema), async (c) => {
  const auth = await authenticateAdmin(c)
  if ('response' in auth) return auth.response
  const admin = auth.user

  const { expiresInDays } = c.req.valid('json')
  const code = randomBytes(24).toString('base64url')
  const now = new Date()
  const invite = {
    id: createId(),
    codeHash: hashToken(code),
    createdByUserId: admin.id,
    createdAt: now,
    expiresAt: new Date(now.getTime() + (expiresInDays ?? DEFAULT_INVITE_TTL_DAYS) * DAY_MS),
  }
  await db.insert(invites).values(invite)

  // The only time the raw code is ever returned - the caller builds the
  // shareable `/register?invite=...` link from it right away.
  return c.json({ id: invite.id, code, createdAt: invite.createdAt.toISOString(), expiresAt: invite.expiresAt.toISOString() }, 201)
})

adminRouter.get('/invites', async (c) => {
  const auth = await authenticateAdmin(c)
  if ('response' in auth) return auth.response

  const statusFilter = c.req.query('status') ?? 'all'
  const [allInvites, allUsers] = await Promise.all([
    db.select().from(invites).all(),
    db.select().from(users).all(),
  ])
  const userById = new Map(allUsers.map((u) => [u.id, u]))
  const now = new Date()

  const withStatus = allInvites.map((inv) => {
    const status = inv.usedAt ? 'used' : inv.revokedAt ? 'revoked' : inv.expiresAt < now ? 'expired' : 'pending'
    const usedBy = inv.usedByUserId ? userById.get(inv.usedByUserId) : undefined
    return {
      id: inv.id,
      createdByName: userById.get(inv.createdByUserId)?.name ?? null,
      createdAt: inv.createdAt.toISOString(),
      expiresAt: inv.expiresAt.toISOString(),
      revokedAt: inv.revokedAt?.toISOString() ?? null,
      usedAt: inv.usedAt?.toISOString() ?? null,
      usedByName: usedBy?.name ?? null,
      usedByEmail: usedBy?.email ?? null,
      status,
    }
  })

  withStatus.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

  const filtered = statusFilter === 'all' ? withStatus : withStatus.filter((i) => i.status === statusFilter)
  return c.json(filtered)
})

adminRouter.delete('/invites/:id', async (c) => {
  const auth = await authenticateAdmin(c)
  if ('response' in auth) return auth.response

  const id = c.req.param('id')
  const invite = await db.select().from(invites).where(eq(invites.id, id)).get()
  if (!invite) return c.json({ error: 'Invite not found' }, 404)
  if (invite.usedAt) return c.json({ error: 'Invite already redeemed' }, 409)

  await db.update(invites).set({ revokedAt: new Date() }).where(eq(invites.id, id))
  return c.json({ ok: true })
})

// ── Users ────────────────────────────────────────────────────────────────

adminRouter.get('/admin/users', async (c) => {
  const auth = await authenticateAdmin(c)
  if ('response' in auth) return auth.response

  const [allUsers, allTokens] = await Promise.all([
    db.select().from(users).all(),
    db.select().from(refreshTokens).all(),
  ])
  const now = new Date()
  const sessionCountByUser = new Map<string, number>()
  for (const t of allTokens) {
    if (t.expiresAt < now) continue
    sessionCountByUser.set(t.userId, (sessionCountByUser.get(t.userId) ?? 0) + 1)
  }

  const result = allUsers
    .map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      createdAt: u.createdAt.toISOString(),
      activeSessionCount: sessionCountByUser.get(u.id) ?? 0,
    }))
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())

  return c.json(result)
})

adminRouter.patch('/admin/users/:id/role', zValidator('json', roleSchema), async (c) => {
  const auth = await authenticateAdmin(c)
  if ('response' in auth) return auth.response

  const id = c.req.param('id')
  const { role } = c.req.valid('json')

  const target = await db.select().from(users).where(eq(users.id, id)).get()
  if (!target) return c.json({ error: 'User not found' }, 404)

  if (await wouldOrphanAdmins(id, role === 'user')) {
    return c.json({ error: 'Cannot demote the last remaining admin' }, 409)
  }

  await db.update(users).set({ role }).where(eq(users.id, id))
  return c.json({ id: target.id, email: target.email, name: target.name, role })
})

// Force-logout: ends every one of the target's sessions without touching
// their account, unlike the self-service "Выйти на всех устройствах"
// (DELETE /auth/sessions) which also clears the caller's own cookie - here
// the caller (the admin) and the target are different people, so there's
// no cookie of the admin's own to clear.
adminRouter.delete('/admin/users/:id/sessions', async (c) => {
  const auth = await authenticateAdmin(c)
  if ('response' in auth) return auth.response

  const id = c.req.param('id')
  const target = await db.select().from(users).where(eq(users.id, id)).get()
  if (!target) return c.json({ error: 'User not found' }, 404)

  await db.delete(refreshTokens).where(eq(refreshTokens.userId, id))
  return c.json({ ok: true })
})

// Deleting someone else's account is destructive and irreversible enough
// that a possibly-stolen admin access token alone shouldn't be sufficient
// - the acting admin's own password is re-checked here, the same bar
// self-service DELETE /auth/account already holds itself to.
adminRouter.delete('/admin/users/:id', zValidator('json', adminDeleteSchema), async (c) => {
  const auth = await authenticateAdmin(c)
  if ('response' in auth) return auth.response
  const admin = auth.user

  const { password } = c.req.valid('json')
  if (!(await verifyPassword(password, admin.passwordHash))) {
    return c.json({ error: 'Invalid password' }, 401)
  }

  const id = c.req.param('id')
  const target = await db.select().from(users).where(eq(users.id, id)).get()
  if (!target) return c.json({ error: 'User not found' }, 404)

  if (await wouldOrphanAdmins(id, target.role === 'admin')) {
    return c.json({ error: 'Cannot delete the last remaining admin' }, 409)
  }

  await db.delete(users).where(eq(users.id, id))
  return c.json({ ok: true })
})

// ── Stats ────────────────────────────────────────────────────────────────

adminRouter.get('/admin/stats', async (c) => {
  const auth = await authenticateAdmin(c)
  if ('response' in auth) return auth.response

  const [allUsers, allTokens, allInvites] = await Promise.all([
    db.select().from(users).all(),
    db.select().from(refreshTokens).all(),
    db.select().from(invites).all(),
  ])
  const now = new Date()
  const totalActiveSessions = allTokens.filter((t) => t.expiresAt >= now).length
  const pendingInvites = allInvites.filter((i) => !i.usedAt && !i.revokedAt && i.expiresAt >= now).length

  const thirtyDaysAgo = new Date(now.getTime() - 30 * DAY_MS)
  const newUsersLast30d = allUsers.filter((u) => u.createdAt >= thirtyDaysAgo).length

  const registrationsByDay: { date: string; count: number }[] = []
  for (let i = 29; i >= 0; i--) {
    const dateStr = new Date(now.getTime() - i * DAY_MS).toISOString().slice(0, 10)
    const count = allUsers.filter((u) => u.createdAt.toISOString().slice(0, 10) === dateStr).length
    registrationsByDay.push({ date: dateStr, count })
  }

  return c.json({
    totalUsers: allUsers.length,
    totalActiveSessions,
    pendingInvites,
    newUsersLast30d,
    registrationsByDay,
  })
})
