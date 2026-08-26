import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertSchemaCurrent,
  migrateDatabase,
  parseMigrateOnStartup,
  prepareDatabase,
} from '../db/migrate.js'

const databases: Database.Database[] = []

function database() {
  const sqlite = new Database(':memory:')
  databases.push(sqlite)
  return { sqlite, db: drizzle(sqlite) }
}

afterEach(() => {
  for (const sqlite of databases.splice(0)) sqlite.close()
})

describe('MIGRATE_ON_STARTUP', () => {
  it.each([undefined, '', 'false'])('disables migration for %s', (value) => {
    expect(parseMigrateOnStartup(value)).toBe(false)
  })

  it('enables migration only for true', () => {
    expect(parseMigrateOnStartup('true')).toBe(true)
  })

  it.each(['TRUE', 'False', '0', ' true ', 'yes'])('rejects %s', (value) => {
    expect(() => parseMigrateOnStartup(value)).toThrow('MIGRATE_ON_STARTUP must be true or false')
  })
})

describe('application migrator', () => {
  it('migrates a fresh database and is idempotent', () => {
    const { sqlite, db } = database()

    migrateDatabase(db)
    const firstCount = sqlite.prepare('SELECT count(*) AS count FROM __drizzle_migrations').get() as { count: number }
    migrateDatabase(db)
    const secondCount = sqlite.prepare('SELECT count(*) AS count FROM __drizzle_migrations').get() as { count: number }

    expect(firstCount.count).toBeGreaterThan(0)
    expect(secondCount.count).toBe(firstCount.count)
    expect(() => assertSchemaCurrent(sqlite)).not.toThrow()
  })

  it('rejects a missing or stale tracking table when startup migration is disabled', () => {
    const fresh = database()
    expect(() => prepareDatabase(fresh.db, fresh.sqlite, false)).toThrow('Database schema is not current')

    const migrated = database()
    migrateDatabase(migrated.db)
    // drizzle-orm's better-sqlite3 migrator declares `id SERIAL PRIMARY KEY`,
    // a Postgres-ism SQLite doesn't recognize as a rowid alias, so `id` is
    // always NULL here; use the implicit `rowid` to target the latest row.
    migrated.sqlite.prepare('DELETE FROM __drizzle_migrations WHERE rowid = (SELECT max(rowid) FROM __drizzle_migrations)').run()
    expect(() => assertSchemaCurrent(migrated.sqlite)).toThrow('Database schema is not current')
  })
})
