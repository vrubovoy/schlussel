import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { themePreference } from '../db/schema.js'

// Single shared value across the whole install (not per-user or
// authenticated) - schloss and kuvert each read/write it directly over a
// plain cross-origin fetch (CORS-enabled, see middleware/cors.ts) to sync
// the theme preference across the platform's separate origins, since
// their own localStorage can't be shared directly. This replaces an
// earlier hidden-iframe + postMessage + localStorage design that turned
// out to be fundamentally broken by Firefox's Total Cookie Protection,
// which partitions localStorage (and BroadcastChannel) inside a
// third-party iframe by whichever site embeds it - the same hub page
// embedded in two different apps saw two completely separate storage
// buckets, so nothing ever actually synced. A plain fetch response isn't
// subject to that at all.
const THEMES = ['light', 'dark', 'oled', 'sepia'] as const

const themeSchema = z.object({
  theme: z.enum(THEMES),
  updatedAt: z.number().int().nonnegative(),
})

export const themeRouter = new Hono()

const ROW_ID = 1

themeRouter.get('/', async (c) => {
  const row = await db.select().from(themePreference).where(eq(themePreference.id, ROW_ID)).get()
  return c.json({ theme: row?.theme ?? null, updatedAt: row?.updatedAt ?? 0 })
})

// Last write wins by `updatedAt` - silently no-ops (returning the current,
// still-newer value) instead of erroring, since a losing write here is
// completely normal (two origins racing to report a value can't both go
// first) rather than a real error a caller needs to handle.
themeRouter.put('/', zValidator('json', themeSchema), async (c) => {
  const { theme, updatedAt } = c.req.valid('json')
  const existing = await db.select().from(themePreference).where(eq(themePreference.id, ROW_ID)).get()

  if (existing && updatedAt <= existing.updatedAt) {
    return c.json({ theme: existing.theme, updatedAt: existing.updatedAt })
  }
  if (existing) {
    await db.update(themePreference).set({ theme, updatedAt }).where(eq(themePreference.id, ROW_ID))
  } else {
    await db.insert(themePreference).values({ id: ROW_ID, theme, updatedAt })
  }
  return c.json({ theme, updatedAt })
})
