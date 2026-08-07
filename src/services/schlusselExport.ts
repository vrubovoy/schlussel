import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { connectedAccounts, refreshTokens, users, type User } from '../db/schema.js'

export function schlusselProfileJson(user: User) {
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

function accountExport(
  user: User,
  sessions: Array<typeof refreshTokens.$inferSelect>,
  accounts: Array<typeof connectedAccounts.$inferSelect>,
  now: Date,
) {
  return {
    exportedAt: now.toISOString(),
    scope: 'schlussel-account-only' as const,
    profile: schlusselProfileJson(user),
    createdAt: user.createdAt,
    sessions: sessions.map((session) => ({
      userAgent: session.userAgent,
      ipAddress: session.ipAddress,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
    })),
    connectedAccounts: accounts.map((account) => ({
      provider: account.provider,
      externalUsername: account.externalUsername,
      connectedAt: account.connectedAt,
    })),
  }
}

export function createSchlusselAccountExport(user: User, now: Date = new Date()) {
  return db.transaction((tx) => accountExport(
    user,
    tx.select().from(refreshTokens).where(eq(refreshTokens.userId, user.id)).all(),
    tx.select().from(connectedAccounts).where(eq(connectedAccounts.userId, user.id)).all(),
    now,
  ))
}

export function createSchlusselSnapshot(ownerUserId: string, now: Date = new Date()) {
  return db.transaction((tx) => {
    const user = tx.select().from(users).where(eq(users.id, ownerUserId)).get()
    if (!user) throw new Error('Export owner no longer exists')
    return {
      version: '1' as const,
      service: 'schlussel',
      exportedAt: now.toISOString(),
      data: accountExport(
        user,
        tx.select().from(refreshTokens).where(eq(refreshTokens.userId, ownerUserId)).all(),
        tx.select().from(connectedAccounts).where(eq(connectedAccounts.userId, ownerUserId)).all(),
        now,
      ),
    }
  })
}
