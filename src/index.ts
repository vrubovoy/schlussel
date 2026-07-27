import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { initKeys, getJwks } from './utils/keys.js'
import { corsMiddleware } from './middleware/cors.js'
import { authRouter } from './routes/auth.js'
import { adminRouter, authenticateAdmin } from './routes/admin.js'
import { openApiDocument } from './openapi.js'
import { db } from './db/index.js'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'

// Resolved relative to this file so it works both in dev (src/index.ts,
// migrations at src/db/migrations) and in the compiled build
// (dist/index.js, migrations at dist/db/migrations) without a hardcoded
// path that only matches one of the two.
const __dirname = dirname(fileURLToPath(import.meta.url))

await initKeys()
migrate(db, { migrationsFolder: join(__dirname, 'db/migrations') })

const app = new Hono()

app.use('*', logger())
app.use('*', corsMiddleware)

app.get('/.well-known/jwks.json', (c) => c.json(getJwks()))
app.get('/health', (c) => c.json({ status: 'ok', service: 'Schlüssel' }))

app.route('/auth', authRouter)
app.route('/auth', adminRouter)

// Lives here rather than inside admin.ts/adminRouter, since openapi.ts
// imports admin.ts's own schemas to describe them - mounting it in
// admin.ts too would create an import cycle.
app.get('/auth/openapi.json', async (c) => {
  const auth = await authenticateAdmin(c)
  if ('response' in auth) return auth.response
  return c.json(openApiDocument)
})

const PORT = Number(process.env['PORT'] ?? 4000)

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`[Schlüssel] Running on http://localhost:${PORT}`)
})
