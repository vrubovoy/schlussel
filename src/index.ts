import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { bodyLimit } from 'hono/body-limit'
import { initKeys, getJwks } from './utils/keys.js'
import { corsMiddleware } from './middleware/cors.js'
import { authRouter } from './routes/auth.js'
import { adminRouter, authenticateAdmin } from './routes/admin.js'
import { themeRouter } from './routes/theme.js'
import { createInternalRouter } from './routes/internal.js'
import { openApiDocument } from './openapi.js'
import { db, sqlite } from './db/index.js'
import { assertSchemaCurrent, parseMigrateOnStartup, prepareDatabase } from './db/migrate.js'
import { buildInfo } from './build-info.js'
import { startOutboxDispatcher } from './services/outboxDispatcher.js'
import { createExportServices, startExportWorker } from './services/exportWorker.js'
import { loadDeletionConfig, loadExportConfig, loadNotificationConfig } from './config.js'
import { startDeletionWorker } from './services/deletionSaga.js'

const notificationConfig = loadNotificationConfig()
const exportConfig = loadExportConfig()
const deletionConfig = loadDeletionConfig()

prepareDatabase(db, sqlite, parseMigrateOnStartup(process.env['MIGRATE_ON_STARTUP']))
await initKeys()

const app = new Hono()

app.use('*', logger())
app.use('*', corsMiddleware)
// Comfortably covers a PUT /auth/avatar body (MAX_AVATAR_BYTES raw image,
// base64-encoded plus JSON wrapping - see routes/auth.ts) with headroom to
// spare; every other request body on this API is tiny by comparison.
app.use('*', bodyLimit({
  maxSize: 1 * 1024 * 1024,
  onError: (c) => c.json({ error: 'Request body too large' }, 413),
}))

app.get('/.well-known/jwks.json', (c) => c.json(getJwks()))
app.get('/health', (c) => c.json({ status: 'ok', service: 'Schlüssel', ...buildInfo }))
app.get('/ready', (c) => {
  try {
    assertSchemaCurrent(sqlite)
    return c.json({ status: 'ready', service: 'Schlüssel' })
  } catch {
    return c.json({ status: 'unavailable', service: 'Schlüssel' }, 503)
  }
})

app.route('/auth', authRouter)
app.route('/auth', adminRouter)
app.route('/theme', themeRouter)
if (notificationConfig) {
  app.route('/internal', createInternalRouter({
    keyId: notificationConfig.inboundKeyId,
    secret: notificationConfig.inboundSecret,
    maxSkewSeconds: notificationConfig.signatureMaxSkewSeconds,
  }))
}

// Lives here rather than inside admin.ts/adminRouter, since openapi.ts
// imports admin.ts's own schemas to describe them - mounting it in
// admin.ts too would create an import cycle.
app.get('/auth/openapi.json', async (c) => {
  const auth = await authenticateAdmin(c)
  if ('response' in auth) return auth.response
  return c.json(openApiDocument)
})

const PORT = Number(process.env['PORT'] ?? 4000)

const server = serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`[Schlüssel] Running on http://localhost:${PORT}`)
})

const dispatcher = notificationConfig ? startOutboxDispatcher({
  glockeBaseUrl: notificationConfig.glockeBaseUrl,
  keyId: notificationConfig.outboundKeyId,
  secret: notificationConfig.outboundSecret,
  intervalMs: notificationConfig.dispatchIntervalMs,
  leaseMs: notificationConfig.leaseMs,
  fetchTimeoutMs: notificationConfig.fetchTimeoutMs,
  stopTimeoutMs: notificationConfig.workerStopTimeoutMs,
  maxAttempts: notificationConfig.maxAttempts,
  baseDelayMs: notificationConfig.baseDelayMs,
  maxDelayMs: notificationConfig.maxDelayMs,
  onError: () => console.error('[Schlüssel] Notification outbox dispatch failed'),
}) : { stop: async () => {} }

const exportWorker = startExportWorker({
  exportDir: exportConfig.exportDir,
  services: createExportServices(exportConfig),
  intervalMs: exportConfig.dispatchIntervalMs,
  leaseMs: exportConfig.leaseMs,
  requestTimeoutMs: exportConfig.requestTimeoutMs,
  maxResponseBytes: exportConfig.maxResponseBytes,
  maxAggregateBytes: exportConfig.maxAggregateBytes,
  maxConcurrency: exportConfig.maxConcurrency,
  artifactTtlMs: exportConfig.artifactTtlMs,
  storageQuotaBytes: exportConfig.storageQuotaBytes,
  minFreeBytes: exportConfig.minFreeBytes,
  maxUserRetainedArtifactBytes: exportConfig.maxRetainedArtifactBytesPerUser,
  stopTimeoutMs: exportConfig.workerStopTimeoutMs,
  onError: () => console.error('[Schlüssel] Export worker failed'),
})

const deletionWorker = startDeletionWorker({
  ...deletionConfig,
  onError: () => console.error('[Schlüssel] Account deletion dispatch failed'),
})

let shutdownStarted = false
async function shutdown() {
  if (shutdownStarted) return
  shutdownStarted = true
  server.close()
  await Promise.all([dispatcher.stop(), exportWorker.stop(), deletionWorker.stop()])
}

process.once('SIGINT', () => { void shutdown() })
process.once('SIGTERM', () => { void shutdown() })
