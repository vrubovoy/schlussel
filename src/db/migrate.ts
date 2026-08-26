import type Database from 'better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), 'migrations')

export function parseMigrateOnStartup(value: string | undefined): boolean {
  if (value === 'true') return true
  if (value == null || value === '' || value === 'false') return false
  throw new Error('MIGRATE_ON_STARTUP must be true or false')
}

export function migrateDatabase(database: Parameters<typeof migrate>[0]): void {
  migrate(database, { migrationsFolder })
}

export function assertSchemaCurrent(sqlite: Database.Database): void {
  const expected = readMigrationFiles({ migrationsFolder })
  let applied: Array<{ hash: string; created_at: number }>
  try {
    applied = sqlite.prepare(
      'SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at, id',
    ).all() as Array<{ hash: string; created_at: number }>
  } catch {
    throw new Error('Database schema is not current; run db:migrate')
  }

  const current = applied.length === expected.length && expected.every((migration, index) => {
    const tracked = applied[index]
    return tracked?.hash === migration.hash && tracked.created_at === migration.folderMillis
  })
  if (!current) throw new Error('Database schema is not current; run db:migrate')
}

export function prepareDatabase(
  database: Parameters<typeof migrate>[0],
  sqlite: Database.Database,
  migrateOnStartup: boolean,
): void {
  if (migrateOnStartup) migrateDatabase(database)
  else assertSchemaCurrent(sqlite)
}
