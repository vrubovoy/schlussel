import { afterAll, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const root = join(tmpdir(), `schlussel-upgrade-${randomUUID()}`)
const legacyMigrations = join(root, 'legacy-migrations')
const fullMigrations = fileURLToPath(new URL('../db/migrations', import.meta.url))

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('database migration upgrade', () => {
  it('upgrades a populated 0006 database without losing account or session data', () => {
    mkdirSync(join(legacyMigrations, 'meta'), { recursive: true })
    const journal = JSON.parse(readFileSync(join(fullMigrations, 'meta/_journal.json'), 'utf8')) as {
      version: string
      dialect: string
      entries: Array<{ idx: number; tag: string }>
    }
    const legacyJournal = { ...journal, entries: journal.entries.filter(({ idx }) => idx <= 6) }
    writeFileSync(join(legacyMigrations, 'meta/_journal.json'), JSON.stringify(legacyJournal))
    for (const file of readdirSync(fullMigrations).filter((name) => /^000[0-6]_.*\.sql$/.test(name))) {
      copyFileSync(join(fullMigrations, file), join(legacyMigrations, file))
    }

    const sqlite = new Database(join(root, 'upgrade.db'))
    sqlite.pragma('foreign_keys = ON')
    const database = drizzle(sqlite)
    migrate(database, { migrationsFolder: legacyMigrations })
    sqlite.prepare(`
      INSERT INTO users (id, email, password_hash, name, role, created_at)
      VALUES ('legacy-user', 'legacy@example.com', 'hash', 'Legacy User', 'user', ?)
    `).run(Math.floor(Date.now() / 1000))
    sqlite.prepare(`
      INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at)
      VALUES ('legacy-session', 'legacy-user', 'legacy-token-hash', ?, ?)
    `).run(Math.floor(Date.now() / 1000) + 3600, Math.floor(Date.now() / 1000))

    migrate(database, { migrationsFolder: fullMigrations })

    expect(sqlite.prepare('SELECT email FROM users WHERE id = ?').get('legacy-user')).toEqual({
      email: 'legacy@example.com',
    })
    expect(sqlite.prepare('SELECT token_hash FROM refresh_tokens WHERE id = ?').get('legacy-session')).toEqual({
      token_hash: 'legacy-token-hash',
    })
    expect(sqlite.prepare(`SELECT name FROM pragma_table_info('export_job_services') WHERE name = 'snapshot_path'`).get()).toEqual({
      name: 'snapshot_path',
    })
    expect(sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'export_job_events'`).get()).toEqual({
      name: 'export_job_events',
    })
    expect(sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'deletion_jobs'`).get()).toEqual({
      name: 'deletion_jobs',
    })
    expect(sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'deletion_job_targets'`).get()).toEqual({
      name: 'deletion_job_targets',
    })
    sqlite.close()
  })
})
