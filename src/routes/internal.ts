import { verifyNotificationRequest } from '@zudar107/schloss-server-kit'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'

export interface InternalRouterOptions {
  keyId: string
  secret: string
  maxSkewSeconds: number
}

export function createInternalRouter(options: InternalRouterOptions) {
  const internalRouter = new Hono()

  internalRouter.get('/v1/notification-recipients/:userId', async (c) => {
    const timestamp = Number(c.req.header('X-Hof-Timestamp'))
    const requestUrl = new URL(c.req.url)

    if (!verifyNotificationRequest({
      secret: options.secret,
      keyId: c.req.header('X-Hof-Key-Id') ?? '',
      source: c.req.header('X-Hof-Service') ?? '',
      timestamp,
      method: c.req.method,
      path: `${requestUrl.pathname}${requestUrl.search}`,
      rawBody: '',
      signature: c.req.header('X-Hof-Signature') ?? '',
      expectedKeyId: options.keyId,
      expectedSource: 'glocke',
      maxSkewSeconds: options.maxSkewSeconds,
    })) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const user = await db.select({
      userId: users.id,
      notifyInApp: users.notifyInApp,
      notifyBrowserPush: users.notifyBrowserPush,
      language: users.language,
      timezone: users.timezone,
    }).from(users).where(eq(users.id, c.req.param('userId'))).get()

    if (!user) return c.json({ error: 'Not found' }, 404)
    return c.json(user)
  })

  return internalRouter
}
