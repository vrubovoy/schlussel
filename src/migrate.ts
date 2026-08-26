import { db, sqlite } from './db/index.js'
import { migrateDatabase } from './db/migrate.js'

try {
  migrateDatabase(db)
} finally {
  sqlite.close()
}
