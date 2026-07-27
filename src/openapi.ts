import { OpenAPIRegistry, OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi'
import { z } from 'zod'
import {
  registerSchema,
  loginSchema,
  tokenSchema,
  changePasswordSchema,
  deleteAccountSchema,
  nameSchema,
} from './routes/auth.js'
import { createInviteSchema, roleSchema, adminDeleteSchema } from './routes/admin.js'

// Purely additive/descriptive: this file only describes the API surface
// already implemented in routes/auth.ts and routes/admin.ts by reusing
// their real Zod schemas. It has zero effect on runtime request
// validation - deleting it wouldn't change any endpoint's behavior.

const registry = new OpenAPIRegistry()

registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
})

const errorSchema = z.object({ error: z.string() })

const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: z.enum(['admin', 'user']),
})

const sessionSchema = z.object({
  id: z.string(),
  userAgent: z.string().nullable(),
  ipAddress: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
  current: z.boolean(),
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
  request: { body: { content: { 'application/json': { schema: loginSchema } } } },
  responses: {
    200: { description: 'A short-lived auth code (PKCE) or an access token, depending on the request' },
    401: { description: 'Invalid credentials', content: { 'application/json': { schema: errorSchema } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/token',
  summary: 'Exchange a PKCE code for an access token',
  request: { body: { content: { 'application/json': { schema: tokenSchema } } } },
  responses: {
    200: { description: 'OK' },
    400: { description: 'Invalid or expired code', content: { 'application/json': { schema: errorSchema } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/refresh',
  summary: 'Rotate the refresh-token cookie for a new access token',
  responses: {
    200: { description: 'OK' },
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
