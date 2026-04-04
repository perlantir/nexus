/**
 * db/index.ts — primary entry point for the DeciGraph database layer.
 *
 * Provides a module-level singleton adapter with a simple lifecycle:
 *
 *   1. Call `initDb(config?)` once at application start-up.
 *   2. Anywhere else, call `getDb()` to obtain the live adapter.
 *   3. Call `closeDb()` during graceful shutdown.
 *
 * The existing `pool.ts` and `parsers.ts` are intentionally left untouched.
 * Code that currently imports from `./pool.js` continues to work unmodified.
 * New code should import from `./index.js` (this file) instead.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseAdapter } from './adapter.js';
import { createAdapter, type DatabaseConfig } from './factory.js';

// ---------------------------------------------------------------------------
// ESM-compatible __dirname equivalent
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Singleton adapter
// ---------------------------------------------------------------------------

let _db: DatabaseAdapter | null = null;

/**
 * Initialise the database adapter singleton.
 *
 * Idempotent: if `initDb` has already been called and the adapter is still
 * live, returns the existing instance without re-connecting or re-running
 * migrations.
 *
 * @param config  Optional configuration.  If omitted, dialect is resolved
 *                from environment variables (DATABASE_URL, etc.).
 */
export async function initDb(config?: DatabaseConfig): Promise<DatabaseAdapter> {
  if (_db) return _db;

  _db = await createAdapter(config);
  await _db.connect();

  const migrationsDir = getMigrationsDir(_db.dialect);
  await _db.runMigrations(migrationsDir);

  return _db;
}

/**
 * Return the live adapter instance.
 *
 * @throws Error if `initDb()` has not been called yet.
 */
export function getDb(): DatabaseAdapter {
  if (!_db) {
    throw new Error(
      '[decigraph/db] Database not initialised. Call initDb() before getDb().',
    );
  }
  return _db;
}

/**
 * Close the adapter and release all resources.  Resets the singleton so that
 * a subsequent `initDb()` call creates a fresh connection.
 */
export async function closeDb(): Promise<void> {
  if (_db) {
    await _db.close();
    _db = null;
  }
}

// ---------------------------------------------------------------------------
// Migrations directory resolution
// ---------------------------------------------------------------------------

/**
 * Return the absolute path to the migrations directory for the given dialect.
 *
 * - SQLite:     `<this file's dir>/migrations/sqlite/`
 * - PostgreSQL: `<repo root>/supabase/migrations/`
 */
function getMigrationsDir(dialect: 'sqlite' | 'postgres'): string {
  if (dialect === 'sqlite') {
    return path.join(__dirname, 'migrations', 'sqlite');
  }
  // Walk up: packages/core/src/db → packages/core/src → packages/core → packages → repo root
  return path.resolve(__dirname, '..', '..', '..', '..', 'supabase', 'migrations');
}

// ---------------------------------------------------------------------------
// Re-exports — backward-compatible public API
// ---------------------------------------------------------------------------

export type { DatabaseAdapter, QueryResult } from './adapter.js';
export type { DatabaseConfig } from './factory.js';
export { createAdapter, resolveDialect } from './factory.js';
