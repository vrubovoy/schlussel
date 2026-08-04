import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // Use forks (separate processes) so native modules (better-sqlite3) and
    // process.env mutations don't bleed across test files.
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // frontend/ and schloss-ui/ are their own workspace packages with their
    // own vitest.config.ts (jsdom environment) — without this exclude,
    // running from the repo root would also pick up their test files
    // under the wrong environment.
    exclude: ['**/node_modules/**', 'frontend/**', 'schloss-ui/**'],
  },
})
