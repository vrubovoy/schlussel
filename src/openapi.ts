import { OpenAPIRegistry, OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi'
import { z } from 'zod'
import {
  registerSchema,
  loginSchema,
  tokenSchema,
  changePasswordSchema,
  deleteAccountSchema,
  nameSchema,
  profileUpdateSchema,
  avatarSchema,
  refreshSchema,
} from './routes/auth.js'
import { createInviteSchema, roleSchema, adminDeleteSchema } from './routes/admin.js'
import { themeSchema } from './routes/theme.js'

// Purely additive/descriptive: this file only describes the API surface
// already implemented by the auth, admin, theme, health, and JWKS routes,
// reusing their real request schemas where applicable. It has zero effect
// on runtime request validation - deleting it wouldn't change any
// endpoint's behavior.

const registry = new OpenAPIRegistry()

registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
})

const errorSchema = z.object({ error: z.string() })
const okSchema = z.object({ ok: z.literal(true) })

const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: z.enum(['admin', 'user']),
})

const accessTokenSchema = z.string().describe(
  'Short-lived RS256 JWT. In addition to identity claims, its payload includes nullable timezone, dateFormat, and weekStart profile preferences.',
)

const accessTokenResponseSchema = z.object({
  accessToken: accessTokenSchema,
  user: userSchema,
})

const authCodeResponseSchema = z.object({ code: z.string() })

const sessionSchema = z.object({
  id: z.string(),
  userAgent: z.string().nullable(),
  ipAddress: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
  current: z.boolean(),
})

const profileSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: z.enum(['admin', 'user']),
  avatarDataUrl: z.string().nullable(),
  timezone: z.string().nullable(),
  dateFormat: z.enum(['dmy', 'mdy', 'ymd']).nullable(),
  weekStart: z.enum(['monday', 'sunday']).nullable(),
  language: z.enum(['ru', 'en']).nullable(),
  notifyInApp: z.boolean(),
  notifyBrowserPush: z.boolean(),
  notifyTelegram: z.boolean(),
  sessionTimeoutMinutes: z.number().nullable(),
})

const connectedAccountSchema = z.object({
  id: z.string(),
  provider: z.enum(['telegram']),
  externalUsername: z.string().nullable(),
  connectedAt: z.string(),
})

const exportJobServiceSchema = z.object({
  service: z.enum(['schlussel', 'kuvert', 'tafel', 'zettel', 'glocke']),
  status: z.enum(['pending', 'running', 'succeeded', 'failed', 'cancelled']),
  attempts: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative().nullable(),
  sha256: z.string().nullable(),
  error: z.string().nullable(),
})

const exportJobSchema = z.object({
  id: z.string(),
  status: z.enum(['queued', 'running', 'completed', 'partial', 'failed', 'cancelled', 'expired']),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  downloadUrl: z.string().nullable(),
  error: z.string().nullable(),
  services: z.array(exportJobServiceSchema),
})

const inviteSchema = z.object({
  id: z.string(),
  createdByName: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
  usedAt: z.string().nullable(),
  usedByName: z.string().nullable(),
  usedByEmail: z.string().nullable(),
  status: z.enum(['pending', 'used', 'expired', 'revoked']),
})

const adminUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: z.enum(['admin', 'user']),
  createdAt: z.string(),
  activeSessionCount: z.number(),
})

const themeResponseSchema = z.object({
  theme: z.enum(['light', 'dark', 'oled', 'sepia']).nullable(),
  updatedAt: z.number().int().nonnegative(),
})

// These routes live outside the global /auth server prefix, so each public
// operation overrides it with the API root.
registry.registerPath({
  method: 'get',
  path: '/theme',
  summary: 'Get the install-wide theme preference',
  servers: [{ url: '/' }],
  responses: {
    200: { description: 'OK', content: { 'application/json': { schema: themeResponseSchema } } },
  },
})

registry.registerPath({
  method: 'put',
  path: '/theme',
  summary: 'Update the install-wide theme preference',
  description: 'Uses last-write-wins ordering by the client-supplied updatedAt timestamp, which may be at most five minutes ahead of server time. A stale or equal write is a successful no-op and returns the current winning preference.',
  servers: [{ url: '/' }],
  request: { body: { content: { 'application/json': { schema: themeSchema } } } },
  responses: {
    200: { description: 'Current theme preference', content: { 'application/json': { schema: themeResponseSchema } } },
    400: { description: 'Invalid theme or update timestamp' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/health',
  summary: 'Check service health',
  servers: [{ url: '/' }],
  responses: {
    200: {
      description: 'Healthy',
      content: { 'application/json': { schema: z.object({ status: z.literal('ok'), service: z.literal('Schlüssel') }) } },
    },
  },
})

registry.registerPath({
  method: 'get',
  path: '/.well-known/jwks.json',
  summary: 'Get the JWT verification keys',
  servers: [{ url: '/' }],
  responses: {
    200: {
      description: 'JSON Web Key Set',
      content: {
        'application/json': {
          schema: z.object({
            keys: z.array(z.object({
              kty: z.string(),
              n: z.string(),
              e: z.string(),
              use: z.literal('sig'),
              alg: z.literal('RS256'),
              kid: z.string(),
            })),
          }),
        },
      },
    },
  },
})

// ── Self-service auth ────────────────────────────────────────────────────

registry.registerPath({
  method: 'post',
  path: '/register',
  summary: 'Register a new account',
  description: 'Requires an admin-issued invite code, unless this is the first user on the platform.',
  request: { body: { content: { 'application/json': { schema: registerSchema } } } },
  responses: {
    201: { description: 'Created', content: { 'application/json': { schema: userSchema } } },
    400: { description: 'Invalid or missing invite code', content: { 'application/json': { schema: errorSchema } } },
    409: { description: 'Email already registered', content: { 'application/json': { schema: errorSchema } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/login',
  summary: 'Log in with email and password',
  description: 'codeChallenge and codeChallengeMethod must either both be omitted or both be supplied. The only supported method is S256; the PKCE form returns a one-time code, while the credentials-only form returns an access token directly.',
  request: { body: { content: { 'application/json': { schema: loginSchema } } } },
  responses: {
    200: {
      description: 'A one-time PKCE code or an access token, depending on the request',
      content: { 'application/json': { schema: z.union([authCodeResponseSchema, accessTokenResponseSchema]) } },
    },
    400: { description: 'Invalid request body' },
    401: { description: 'Invalid credentials', content: { 'application/json': { schema: errorSchema } } },
    429: { description: 'Too many failed login attempts', content: { 'application/json': { schema: errorSchema } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/token',
  summary: 'Exchange a PKCE code for an access token',
  description: 'The returned access token contains the current timezone, dateFormat, and weekStart profile preferences as nullable JWT claims.',
  request: { body: { content: { 'application/json': { schema: tokenSchema } } } },
  responses: {
    200: { description: 'Access token and current user', content: { 'application/json': { schema: accessTokenResponseSchema } } },
    400: { description: 'Invalid or expired code', content: { 'application/json': { schema: errorSchema } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/refresh',
  summary: 'Use the refresh-token cookie for a new access token or PKCE code',
  description: 'The body may be omitted or empty to receive an access token. To receive a one-time code instead, codeChallenge and codeChallengeMethod must both be supplied and the method must be S256. Newly issued access tokens contain the current timezone, dateFormat, and weekStart profile preferences as nullable JWT claims. A trusted hosted-frontend request also rotates the refresh-token cookie.',
  request: { body: { required: false, content: { 'application/json': { schema: refreshSchema } } } },
  responses: {
    200: {
      description: 'An access token, or a one-time PKCE code when a code challenge was supplied',
      content: {
        'application/json': {
          schema: z.union([
            z.object({ accessToken: accessTokenSchema }),
            authCodeResponseSchema,
          ]),
        },
      },
    },
    400: { description: 'Invalid PKCE request body', content: { 'application/json': { schema: errorSchema } } },
    401: { description: 'No, invalid, or expired refresh token', content: { 'application/json': { schema: errorSchema } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/logout',
  summary: 'End the current session',
  responses: { 200: { description: 'OK' } },
})

registry.registerPath({
  method: 'get',
  path: '/me',
  summary: 'Get the current user',
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: 'OK', content: { 'application/json': { schema: userSchema } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: errorSchema } } },
  },
})

registry.registerPath({
  method: 'patch',
  path: '/password',
  summary: 'Change the current user\'s password',
  security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: changePasswordSchema } } } },
  responses: {
    200: { description: 'OK' },
    401: { description: 'Unauthorized or invalid current password', content: { 'application/json': { schema: errorSchema } } },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/account',
  summary: 'Delete the current user\'s account',
  security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: deleteAccountSchema } } } },
  responses: {
    200: { description: 'OK' },
    401: { description: 'Unauthorized or invalid password', content: { 'application/json': { schema: errorSchema } } },
  },
})

registry.registerPath({
  method: 'patch',
  path: '/name',
  summary: 'Update the current user\'s display name',
  security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: nameSchema } } } },
  responses: { 200: { description: 'OK', content: { 'application/json': { schema: userSchema } } } },
})

registry.registerPath({
  method: 'get',
  path: '/profile',
  summary: 'Get the current user\'s full profile',
  description: 'The extended profile shown on the account settings page - GET /me stays the small identity shape every consumer app\'s own auth flow already expects.',
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: 'OK', content: { 'application/json': { schema: profileSchema } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: errorSchema } } },
  },
})

registry.registerPath({
  method: 'patch',
  path: '/profile',
  summary: 'Update the current user\'s profile settings',
  description: 'Only the fields present in the request body are changed. Timezone must be a valid IANA zone; timezone/date format/week start are included in newly issued access tokens and consumed by platform apps. Language is stored for the ongoing i18n rollout. Glocke consumes notifyInApp and notifyBrowserPush through a separately authenticated internal API; notifyBrowserPush is a global switch only - it does not itself register a browser, that happens in Glocke. Telegram remains a future channel. sessionTimeoutMinutes can only shorten, never extend past the platform default, how long a newly-established session lasts.',
  security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: profileUpdateSchema } } } },
  responses: {
    200: { description: 'OK', content: { 'application/json': { schema: profileSchema } } },
    400: { description: 'Invalid profile settings, including an unrecognized IANA timezone' },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: errorSchema } } },
  },
})

registry.registerPath({
  method: 'put',
  path: '/avatar',
  summary: 'Upload the current user\'s avatar',
  description: 'Stored as a base64 data URL directly on the user row - the platform has no dedicated file-storage service yet. Capped at MAX_AVATAR_BYTES of raw image bytes.',
  security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: avatarSchema } } } },
  responses: {
    200: { description: 'OK', content: { 'application/json': { schema: profileSchema } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: errorSchema } } },
    400: { description: 'Not a valid image data URL, or over the size cap', content: { 'application/json': { schema: errorSchema } } },
    413: { description: 'Request body too large', content: { 'application/json': { schema: errorSchema } } },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/avatar',
  summary: 'Remove the current user\'s avatar',
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: 'OK', content: { 'application/json': { schema: profileSchema } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: errorSchema } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/connected-accounts',
  summary: 'List the current user\'s connected external accounts',
  description: 'Always empty in practice today - Telegram is the only planned provider and there is no bot yet to hand a connect flow off to.',
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: 'OK', content: { 'application/json': { schema: z.array(connectedAccountSchema) } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: errorSchema } } },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/connected-accounts/{id}',
  summary: 'Disconnect one of the current user\'s connected accounts',
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: 'Disconnected', content: { 'application/json': { schema: okSchema } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: errorSchema } } },
    404: { description: 'Not found', content: { 'application/json': { schema: errorSchema } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/export',
  summary: 'Export the current user\'s Schlüssel account data',
  description: 'Retained synchronous direct JSON export scoped to Schlüssel-owned profile, preference, session metadata, and connected-account data. It is separate from the asynchronous all-services ZIP created by /export-jobs. Passwords, password hashes, token values, signing keys, runtime configuration, internal worker/audit state, and other services\' data are excluded. The private response is sent with no-store and nosniff headers.',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'OK',
      content: {
        'application/json': {
          schema: z.object({
            exportedAt: z.string(),
            scope: z.literal('schlussel-account-only'),
            profile: profileSchema,
            createdAt: z.string(),
            sessions: z.array(z.object({
              userAgent: z.string().nullable(),
              ipAddress: z.string().nullable(),
              createdAt: z.string(),
              expiresAt: z.string(),
            })),
            connectedAccounts: z.array(z.object({
              provider: z.enum(['telegram']),
              externalUsername: z.string().nullable(),
              connectedAt: z.string(),
            })),
          }),
        },
      },
    },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: errorSchema } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/export-jobs',
  summary: 'Create or return the current platform-wide export job',
  description: 'Queues a durable owner-scoped ZIP export from the static Schlüssel/Kuvert/Tafel/Zettel/Glocke registry. At most one queued or running job exists per user. Each service takes its own local snapshot when called; this is not a distributed point-in-time transaction. Remote calls use non-expired RS256 delegations with the exact issuer, single service audience, token_use=export, data:export scope, and nonempty subject/job/token IDs. Export creation is subject to cooldown, retained-job, retained-byte, response-size, storage-quota, and free-space limits. Request bodies cannot provide service URLs or options.',
  security: [{ bearerAuth: [] }],
  request: { body: { required: false, content: { 'application/json': { schema: z.object({}).strict() } } } },
  responses: {
    202: { description: 'Queued job', content: { 'application/json': { schema: exportJobSchema } } },
    429: { description: 'Per-user cooldown, retained-job cap, or retained-artifact cap reached', content: { 'application/json': { schema: errorSchema } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: errorSchema } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/export-jobs/{id}',
  summary: 'Get export job progress',
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: 'Owner-scoped job status', content: { 'application/json': { schema: exportJobSchema } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: errorSchema } } },
    404: { description: 'Not found', content: { 'application/json': { schema: errorSchema } } },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/export-jobs/{id}',
  summary: 'Cancel an export job',
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    202: { description: 'Cancelled job', content: { 'application/json': { schema: exportJobSchema } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: errorSchema } } },
    404: { description: 'Not found', content: { 'application/json': { schema: errorSchema } } },
    409: { description: 'Job is already terminal', content: { 'application/json': { schema: errorSchema } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/export-jobs/{id}/retry',
  summary: 'Retry failed services in a partial or failed export',
  description: 'Requeues only failed services. Existing successful service snapshots are retained, so retried files may represent a later point in time.',
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    202: { description: 'Requeued job', content: { 'application/json': { schema: exportJobSchema } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: errorSchema } } },
    404: { description: 'Not found', content: { 'application/json': { schema: errorSchema } } },
    409: { description: 'Job cannot be retried', content: { 'application/json': { schema: errorSchema } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/export-jobs/{id}/download',
  summary: 'Download a completed or partial export ZIP',
  description: 'Streams an authenticated owner-only private attachment with no-store and nosniff response headers. A partial archive is available when at least one service succeeded and at least one failed. manifest.json records statuses, attempts, files, byte counts, SHA-256 checksums, timestamps, and sanitized errors; service response bodies are never copied into error diagnostics. Artifacts expire after the configured TTL (24 hours by default) and are removed by cleanup. The ZIP contains sensitive personal data and excludes credentials, runtime configuration, logs, worker leases, internal audit/inbox records, and other users\' data.',
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: 'ZIP archive stream', content: { 'application/zip': { schema: z.string() } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: errorSchema } } },
    404: { description: 'Not found', content: { 'application/json': { schema: errorSchema } } },
    409: { description: 'Artifact is not available yet', content: { 'application/json': { schema: errorSchema } } },
    410: { description: 'Artifact expired', content: { 'application/json': { schema: errorSchema } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/sessions',
  summary: 'List the current user\'s active sessions',
  security: [{ bearerAuth: [] }],
  responses: { 200: { description: 'OK', content: { 'application/json': { schema: z.array(sessionSchema) } } } },
})

registry.registerPath({
  method: 'delete',
  path: '/sessions/{id}',
  summary: 'End one of the current user\'s sessions',
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: 'OK' },
    404: { description: 'Session not found', content: { 'application/json': { schema: errorSchema } } },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/sessions',
  summary: 'Log out everywhere',
  description: 'Ends every session for the current user, including the one making this request.',
  security: [{ bearerAuth: [] }],
  responses: { 200: { description: 'OK' } },
})

// ── Admin: invites ───────────────────────────────────────────────────────

registry.registerPath({
  method: 'post',
  path: '/invites',
  summary: 'Create a registration invite (admin only)',
  security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: createInviteSchema } } } },
  responses: {
    201: {
      description: 'Created - the raw code is only ever returned here',
      content: { 'application/json': { schema: z.object({ id: z.string(), code: z.string(), createdAt: z.string(), expiresAt: z.string() }) } },
    },
    403: { description: 'Not an admin', content: { 'application/json': { schema: errorSchema } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/invites',
  summary: 'List registration invites (admin only)',
  security: [{ bearerAuth: [] }],
  request: { query: z.object({ status: z.enum(['all', 'pending', 'used', 'expired', 'revoked']).optional() }) },
  responses: { 200: { description: 'OK', content: { 'application/json': { schema: z.array(inviteSchema) } } } },
})

registry.registerPath({
  method: 'delete',
  path: '/invites/{id}',
  summary: 'Revoke an unused registration invite (admin only)',
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: 'OK' },
    404: { description: 'Invite not found', content: { 'application/json': { schema: errorSchema } } },
    409: { description: 'Invite already redeemed', content: { 'application/json': { schema: errorSchema } } },
  },
})

// ── Admin: users ─────────────────────────────────────────────────────────

registry.registerPath({
  method: 'get',
  path: '/admin/users',
  summary: 'List all users (admin only)',
  security: [{ bearerAuth: [] }],
  responses: { 200: { description: 'OK', content: { 'application/json': { schema: z.array(adminUserSchema) } } } },
})

registry.registerPath({
  method: 'patch',
  path: '/admin/users/{id}/role',
  summary: 'Change a user\'s role (admin only)',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: roleSchema } } },
  },
  responses: {
    200: { description: 'OK', content: { 'application/json': { schema: userSchema } } },
    409: { description: 'Would leave the platform with no admins', content: { 'application/json': { schema: errorSchema } } },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/admin/users/{id}/sessions',
  summary: 'Force-log-out a user (admin only)',
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: { description: 'OK' } },
})

registry.registerPath({
  method: 'delete',
  path: '/admin/users/{id}',
  summary: 'Delete another user\'s account (admin only)',
  description: 'Requires the acting admin\'s own current password.',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: adminDeleteSchema } } },
  },
  responses: {
    200: { description: 'OK' },
    401: { description: 'Wrong password for the acting admin', content: { 'application/json': { schema: errorSchema } } },
    409: { description: 'Would leave the platform with no admins', content: { 'application/json': { schema: errorSchema } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/admin/stats',
  summary: 'Platform overview stats (admin only)',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'OK',
      content: {
        'application/json': {
          schema: z.object({
            totalUsers: z.number(),
            totalActiveSessions: z.number(),
            pendingInvites: z.number(),
            newUsersLast30d: z.number(),
            registrationsByDay: z.array(z.object({ date: z.string(), count: z.number() })),
          }),
        },
      },
    },
  },
})

export const openApiDocument = new OpenApiGeneratorV3(registry.definitions).generateDocument({
  openapi: '3.0.0',
  info: { title: 'Schlüssel Auth API', version: '0.1.0' },
  servers: [{ url: '/auth' }],
})
