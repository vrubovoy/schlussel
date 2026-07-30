import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  name: text('name').notNull(),
  role: text('role', { enum: ['admin', 'user'] }).notNull().default('user'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

export const refreshTokens = sqliteTable('refresh_tokens', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  // Nullable: older rows predate this column, and not every caller sends
  // a user-agent/forwardable IP. Shown on the account settings page's
  // active-sessions list - not used for anything security-sensitive.
  userAgent: text('user_agent'),
  ipAddress: text('ip_address'),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// OAuth2 authorization-code + PKCE handoff: a short-lived, single-use code
// issued after a successful login, redeemed once at POST /auth/token for
// the real access token — so the token itself never appears in a URL.
export const authCodes = sqliteTable('auth_codes', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  codeHash: text('code_hash').notNull().unique(),
  codeChallenge: text('code_challenge').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// Admin-issued, single-use registration invites. `usedAt` is the
// atomicity guard for redemption (see routes/admin.ts): a conditional
// UPDATE ... WHERE usedAt IS NULL only succeeds for exactly one of two
// concurrent redemption attempts of the same code.
export const invites = sqliteTable('invites', {
  id: text('id').primaryKey(),
  codeHash: text('code_hash').notNull().unique(),
  createdByUserId: text('created_by_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  revokedAt: integer('revoked_at', { mode: 'timestamp' }),
  usedAt: integer('used_at', { mode: 'timestamp' }),
  // set null (not cascade): if the redeeming user is later deleted, the
  // invite's audit trail should still show it was redeemed, not vanish.
  usedByUserId: text('used_by_user_id').references(() => users.id, { onDelete: 'set null' }),
})

// Single shared value across the whole install (not per-user, not
// authenticated) - the platform's three apps each live on their own
// subdomain, so they can't read each other's localStorage directly;
// schloss/kuvert sync the theme preference by reading/writing this
// directly over a plain CORS'd fetch instead. `updatedAt` is deliberately
// a plain integer, not `mode: 'timestamp'` like every other timestamp
// column here - this value is never treated as a real Date anywhere, only
// compared as an opaque, monotonically increasing counter that must match
// the frontend's own epoch-ms `Date.now()` values exactly, with no
// second-rounding from drizzle's timestamp mode.
export const themePreference = sqliteTable('theme_preference', {
  id: integer('id').primaryKey(),
  theme: text('theme').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type RefreshToken = typeof refreshTokens.$inferSelect
export type AuthCode = typeof authCodes.$inferSelect
export type Invite = typeof invites.$inferSelect
export type ThemePreference = typeof themePreference.$inferSelect
