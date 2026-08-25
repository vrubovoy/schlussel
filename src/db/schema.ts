import { sql } from 'drizzle-orm'
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  name: text('name').notNull(),
  role: text('role', { enum: ['admin', 'user'] }).notNull().default('user'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),

  // ── Profile settings (all nullable = "not set, use the frontend's own
  //    display default") ────────────────────────────────────────────
  // A small (see MAX_AVATAR_BYTES in routes/auth.ts) image as a data URL,
  // stored directly in this row rather than a real file store - the
  // platform has no file-storage service yet (planned separately).
  avatarDataUrl: text('avatar_data_url'),
  // IANA zone name (e.g. "Europe/Moscow"). Null = the frontend falls back
  // to the browser's own detected zone rather than a hardcoded one.
  timezone: text('timezone'),
  dateFormat: text('date_format', { enum: ['dmy', 'mdy', 'ymd'] }),
  weekStart: text('week_start', { enum: ['monday', 'sunday'] }),
  // Matches @zudar107/schloss-ui's own `Language` type - no UI reads this
  // yet (every app is still Russian-only), it's stored now so the actual
  // language-switcher rollout has a preference to read from already.
  language: text('language', { enum: ['ru', 'en'] }),
  // Notification channels. Glocke consumes notifyInApp through the signed
  // internal recipient API; push/Telegram remain stored groundwork. In-app
  // defaults on, while push/Telegram default off since both need
  // an explicit opt-in step (a browser permission prompt, a Telegram
  // account link) neither of which exists yet to have actually happened.
  notifyInApp: integer('notify_in_app', { mode: 'boolean' }).notNull().default(true),
  notifyBrowserPush: integer('notify_browser_push', { mode: 'boolean' }).notNull().default(false),
  notifyTelegram: integer('notify_telegram', { mode: 'boolean' }).notNull().default(false),
  // Caps how long a newly-issued refresh token lives (see establishSession
  // in routes/auth.ts) - never extends it past the platform's own
  // REFRESH_TOKEN_MAX_AGE, only ever shortens it. Null = use the platform
  // default untouched.
  sessionTimeoutMinutes: integer('session_timeout_minutes'),
})

// A provider a user has linked an external identity from - Telegram is
// the only planned provider today (as the notification service's mobile
// channel), so it's the only enum member so far; add more as real
// integrations exist rather than speculatively. No connect flow exists
// yet (there's no Telegram bot to hand off to), so this table has no
// rows in practice until that's built - it exists now purely so the
// account page has real data to read a real (currently always-empty)
// list from, instead of a hardcoded placeholder.
export const connectedAccounts = sqliteTable('connected_accounts', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  provider: text('provider', { enum: ['telegram'] }).notNull(),
  externalId: text('external_id').notNull(),
  externalUsername: text('external_username'),
  connectedAt: integer('connected_at', { mode: 'timestamp' }).notNull(),
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
  // Nullable only for authorization codes created before session binding.
  sessionId: text('session_id'),
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

// Producer-side transactional outbox for Glocke. These timestamps remain raw
// epoch-millisecond integers: Drizzle's SQLite timestamp mode serializes Date
// values as seconds, which would lose the precision used by leases and retries.
export const notificationOutbox = sqliteTable('notification_outbox', {
  id: text('id').primaryKey(),
  eventType: text('event_type').notNull(),
  userId: text('user_id').notNull(),
  payload: text('payload').notNull(),
  correlationId: text('correlation_id').notNull(),
  state: text('state', { enum: ['pending', 'inflight', 'delivered', 'permanent'] })
    .notNull()
    .default('pending'),
  createdAt: integer('created_at').notNull(),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: integer('next_attempt_at'),
  leaseId: text('lease_id'),
  leaseUntil: integer('lease_until'),
  deliveredAt: integer('delivered_at'),
  lastError: text('last_error'),
}, (table) => [
  check(
    'notification_outbox_state_check',
    sql`${table.state} in ('pending', 'inflight', 'delivered', 'permanent')`,
  ),
  index('notification_outbox_dispatch_idx').on(
    table.state,
    table.nextAttemptAt,
    table.leaseUntil,
    table.createdAt,
  ),
])

export const deletionJobs = sqliteTable('deletion_jobs', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  initiatedBy: text('initiated_by', { enum: ['self', 'admin'] }).notNull(),
  status: text('status', { enum: ['pending', 'running', 'completed', 'failed'] }).notNull().default('pending'),
  createdAt: integer('created_at').notNull(),
  startedAt: integer('started_at'),
  completedAt: integer('completed_at'),
}, (table) => [
  check('deletion_jobs_status_check', sql`${table.status} in ('pending', 'running', 'completed', 'failed')`),
  index('deletion_jobs_status_idx').on(table.status, table.createdAt),
])

export const deletionJobTargets = sqliteTable('deletion_job_targets', {
  jobId: text('job_id').notNull().references(() => deletionJobs.id, { onDelete: 'cascade' }),
  service: text('service', { enum: ['kuvert', 'tafel', 'zettel', 'glocke', 'schrank', 'herold'] }).notNull(),
  status: text('status', { enum: ['pending', 'inflight', 'delivered', 'permanent'] }).notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: integer('next_attempt_at'),
  leaseId: text('lease_id'),
  leaseUntil: integer('lease_until'),
  deliveredAt: integer('delivered_at'),
  lastError: text('last_error'),
}, (table) => [
  primaryKey({ columns: [table.jobId, table.service] }),
  check('deletion_targets_status_check', sql`${table.status} in ('pending', 'inflight', 'delivered', 'permanent')`),
  index('deletion_targets_dispatch_idx').on(table.status, table.nextAttemptAt, table.leaseUntil),
])

export const exportJobs = sqliteTable('export_jobs', {
  id: text('id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  status: text('status', {
    enum: ['queued', 'running', 'completed', 'partial', 'failed', 'cancelled', 'expired'],
  }).notNull().default('queued'),
  createdAt: integer('created_at').notNull(),
  startedAt: integer('started_at'),
  completedAt: integer('completed_at'),
  expiresAt: integer('expires_at'),
  archivePath: text('archive_path'),
  archiveBytes: integer('archive_bytes'),
  lastError: text('last_error'),
  leaseId: text('lease_id'),
  leaseUntil: integer('lease_until'),
}, (table) => [
  check(
    'export_jobs_status_check',
    sql`${table.status} in ('queued', 'running', 'completed', 'partial', 'failed', 'cancelled', 'expired')`,
  ),
  uniqueIndex('export_jobs_one_active_owner_idx')
    .on(table.ownerUserId)
    .where(sql`${table.status} in ('queued', 'running')`),
  index('export_jobs_dispatch_idx').on(table.status, table.leaseUntil, table.createdAt),
  index('export_jobs_expiry_idx').on(table.expiresAt),
])

export const exportJobServices = sqliteTable('export_job_services', {
  jobId: text('job_id').notNull().references(() => exportJobs.id, { onDelete: 'cascade' }),
  service: text('service', { enum: ['schlussel', 'kuvert', 'tafel', 'zettel', 'glocke', 'schrank', 'herold'] }).notNull(),
  status: text('status', {
    enum: ['pending', 'running', 'succeeded', 'failed', 'cancelled'],
  }).notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  bytes: integer('bytes'),
  sha256: text('sha256'),
  snapshotPath: text('snapshot_path'),
  lastError: text('last_error'),
  startedAt: integer('started_at'),
  completedAt: integer('completed_at'),
}, (table) => [
  primaryKey({ columns: [table.jobId, table.service] }),
  check(
    'export_job_services_status_check',
    sql`${table.status} in ('pending', 'running', 'succeeded', 'failed', 'cancelled')`,
  ),
])

// One immutable metadata row per service attempt. Payloads stay exclusively
// in private files; errors are sanitized before they reach either table.
export const exportJobServiceAttempts = sqliteTable('export_job_service_attempts', {
  id: text('id').primaryKey(),
  jobId: text('job_id').notNull().references(() => exportJobs.id, { onDelete: 'cascade' }),
  service: text('service', { enum: ['schlussel', 'kuvert', 'tafel', 'zettel', 'glocke', 'schrank', 'herold'] }).notNull(),
  attempt: integer('attempt').notNull(),
  status: text('status', { enum: ['running', 'succeeded', 'failed', 'cancelled'] }).notNull(),
  startedAt: integer('started_at').notNull(),
  completedAt: integer('completed_at'),
  bytes: integer('bytes'),
  sha256: text('sha256'),
  error: text('error'),
}, (table) => [
  uniqueIndex('export_job_service_attempt_unique_idx').on(table.jobId, table.service, table.attempt),
  check(
    'export_job_service_attempts_status_check',
    sql`${table.status} in ('running', 'succeeded', 'failed', 'cancelled')`,
  ),
])

export const exportJobEvents = sqliteTable('export_job_events', {
  id: text('id').primaryKey(),
  jobId: text('job_id').notNull().references(() => exportJobs.id, { onDelete: 'cascade' }),
  ownerUserId: text('owner_user_id').notNull(),
  eventType: text('event_type', {
    enum: ['created', 'create_reused', 'retried', 'cancelled', 'downloaded'],
  }).notNull(),
  createdAt: integer('created_at').notNull(),
  metadata: text('metadata'),
}, (table) => [
  check(
    'export_job_events_type_check',
    sql`${table.eventType} in ('created', 'create_reused', 'retried', 'cancelled', 'downloaded')`,
  ),
  index('export_job_events_job_idx').on(table.jobId, table.createdAt),
])

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type RefreshToken = typeof refreshTokens.$inferSelect
export type AuthCode = typeof authCodes.$inferSelect
export type Invite = typeof invites.$inferSelect
export type ThemePreference = typeof themePreference.$inferSelect
export type ConnectedAccount = typeof connectedAccounts.$inferSelect
export type NotificationOutbox = typeof notificationOutbox.$inferSelect
export type DeletionJobTarget = typeof deletionJobTargets.$inferSelect
export type ExportJob = typeof exportJobs.$inferSelect
export type ExportJobService = typeof exportJobServices.$inferSelect
