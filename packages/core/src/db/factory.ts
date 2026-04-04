/**
 * createAdapter() — factory that selects the correct DatabaseAdapter
 * implementation based on configuration and environment variables.
 *
 * Dialect resolution order:
 *  1. config.dialect (explicit override)
 *  2. config.connectionString prefix
 *  3. DATABASE_URL env var prefix
 *  4. Default → 'sqlite'
 */

import type { DatabaseAdapter } from './adapter.js';

export interface DatabaseConfig {
  /** Full connection string, e.g. `postgresql://user:pass@host/db` or a file path. */
  connectionString?: string;
  /** Explicit dialect override. */
  dialect?: 'sqlite' | 'postgres';
  /** Path to the SQLite database file (only used when dialect is 'sqlite'). */
  sqlitePath?: string;
  /** Minimum connections in the pg pool (ignored for SQLite). */
  poolMin?: number;
  /** Maximum connections in the pg pool (ignored for SQLite). */
  poolMax?: number;
  /** Whether to require SSL for the PostgreSQL connection. */
  ssl?: boolean;
}

/**
 * Resolve the dialect from the provided config and environment.
 * Exported for testability.
 */
export function resolveDialect(config?: DatabaseConfig): 'sqlite' | 'postgres' {
  if (config?.dialect) return config.dialect;
  if (config?.connectionString?.startsWith('postgresql://')) return 'postgres';
  if (config?.connectionString?.startsWith('postgres://')) return 'postgres';
  if (process.env['DATABASE_URL']?.startsWith('postgresql://')) return 'postgres';
  if (process.env['DATABASE_URL']?.startsWith('postgres://')) return 'postgres';
  return 'sqlite';
}

/**
 * Instantiate the appropriate DatabaseAdapter for the resolved dialect.
 *
 * The adapter is **not** connected yet — call `adapter.connect()` before
 * issuing any queries (or use `initDb()` from `./index.js` which handles
 * the full lifecycle).
 */
export async function createAdapter(config?: DatabaseConfig): Promise<DatabaseAdapter> {
  const dialect = resolveDialect(config);

  if (dialect === 'postgres') {
    const { PostgresAdapter } = await import('./postgres-adapter.js');
    return new PostgresAdapter(config);
  }

  const { SQLiteAdapter } = await import('./sqlite-adapter.js');

  // Determine the SQLite file path:
  //  1. config.sqlitePath
  //  2. DATABASE_URL env var (if it looks like a file path, not a pg:// URL)
  //  3. Default: './decigraph.db'
  const sqlitePath =
    config?.sqlitePath ??
    (process.env['DATABASE_URL'] && !process.env['DATABASE_URL'].startsWith('postgres')
      ? process.env['DATABASE_URL']
      : undefined) ??
    './decigraph.db';

  return new SQLiteAdapter(sqlitePath);
}
