/**
 * PostgresAdapter
 *
 * Wraps the existing pg Pool from pool.ts and implements DatabaseAdapter.
 * Placeholder style for callers is `?`; we translate to `$1`, `$2`, … before
 * handing the query to pg.
 */

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { getPool } from './pool.js';
import type { DatabaseAdapter, QueryResult, TransactionQueryFn } from './adapter.js';
import type { DatabaseConfig } from './factory.js';

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Placeholder translation
// ---------------------------------------------------------------------------

/**
 * Convert `?` positional placeholders to pg-style `$1`, `$2`, … placeholders.
 * Handles quoted string literals and SQL comments conservatively by only
 * replacing bare `?` characters that appear outside of single-quoted strings.
 */
function translatePlaceholders(sql: string): string {
  if (!sql) return '';
  let idx = 0;
  let inString = false;
  let result = '';

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;

    if (inString) {
      result += ch;
      if (ch === "'") {
        // Handle escaped quote ('') inside string literals
        if (sql[i + 1] === "'") {
          result += sql[++i]!;
        } else {
          inString = false;
        }
      }
    } else {
      if (ch === "'") {
        inString = true;
        result += ch;
      } else if (ch === '?') {
        result += `$${++idx}`;
      } else {
        result += ch;
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// PostgresAdapter
// ---------------------------------------------------------------------------

export class PostgresAdapter implements DatabaseAdapter {
  readonly dialect = 'postgres' as const;

  private _pool: pg.Pool | null = null;
  private readonly _config: DatabaseConfig | undefined;

  constructor(config?: DatabaseConfig) {
    this._config = config ?? {};
    // Ensure connectionString falls back to env
    if (!this._config.connectionString && process.env.DATABASE_URL) {
      this._config.connectionString = process.env.DATABASE_URL;
    }
  }

  // ---- connect / close ----------------------------------------------------

  async connect(): Promise<void> {
    // Initialise (or reuse) the pool and verify connectivity.
    try {
      this._pool = this._buildPool();
    } catch (err) {
      const connStr = this._config?.connectionString ?? process.env.DATABASE_URL ?? '<not set>';
      throw new Error(
        `[decigraph/postgres] Failed to create connection pool. ` +
        `DATABASE_URL=${connStr.replace(/:[^:@]+@/, ':***@')}. ` +
        `Original error: ${(err as Error).message}`,
      );
    }
    const ok = await this.healthCheck();
    if (!ok) {
      const connStr = this._config?.connectionString ?? process.env.DATABASE_URL ?? '<not set>';
      throw new Error(
        `[decigraph/postgres] Database health check failed on connect. ` +
        `DATABASE_URL=${connStr.replace(/:[^:@]+@/, ':***@')}`,
      );
    }
  }

  async close(): Promise<void> {
    if (this._pool) {
      await this._pool.end();
      this._pool = null;
    }
  }

  // ---- health check -------------------------------------------------------

  async healthCheck(): Promise<boolean> {
    try {
      const result = await this._rawQuery<{ ok: number }>('SELECT 1 AS ok', []);
      return (result.rows ?? [])[0]?.ok === 1;
    } catch {
      return false;
    }
  }

  // ---- query --------------------------------------------------------------

  async query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> {
    const translated = translatePlaceholders(sql);
    return this._rawQuery<T>(translated, params ?? []);
  }

  // ---- transaction --------------------------------------------------------

  async transaction<T>(
    fn: (query: TransactionQueryFn) => Promise<T>,
  ): Promise<T> {
    const pool = this._getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const txQuery: TransactionQueryFn = async (sql, params) => {
        const translated = translatePlaceholders(sql);
        const result = await client.query<Record<string, unknown>>(
          translated,
          params as unknown[] | undefined,
        );
        return {
          rows: result.rows ?? [],
          rowCount: result.rowCount ?? (result.rows?.length ?? 0),
        };
      };

      const value = await fn(txQuery);
      await client.query('COMMIT');
      return value;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ---- vectorSearch -------------------------------------------------------

  async vectorSearch(
    table: string,
    embeddingColumn: string,
    queryVector: number[],
    limit: number,
    filters?: Record<string, unknown>,
  ): Promise<QueryResult> {
    const conditions: string[] = [`${embeddingColumn} IS NOT NULL`];
    const params: unknown[] = [JSON.stringify(queryVector), limit];
    let paramIdx = 3;

    if (filters) {
      for (const [key, value] of Object.entries(filters)) {
        conditions.push(`${key} = $${paramIdx++}`);
        params.push(value);
      }
    }

    const where = conditions.join(' AND ');
    const sql = `SELECT * FROM ${table} WHERE ${where} ORDER BY ${embeddingColumn} <=> $1::vector LIMIT $2`;

    return this._rawQuery(sql, params);
  }

  // ---- runMigrations ------------------------------------------------------

  async runMigrations(migrationsDir: string): Promise<void> {
    // Ensure tracking table exists (PostgreSQL dialect).
    await this.query(`
      CREATE TABLE IF NOT EXISTS _decigraph_migrations (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const applied = await this.query<{ name: string }>(
      'SELECT name FROM _decigraph_migrations ORDER BY id',
    );
    const appliedSet = new Set((applied.rows ?? []).map((r) => r.name));

    let files: string[];
    try {
      files = fs
        .readdirSync(migrationsDir)
        .filter((f) => f.endsWith('.sql'))
        .sort();
    } catch (err) {
      console.warn(`[decigraph/postgres] Migrations directory not found: ${migrationsDir}. Skipping migrations.`);
      return;
    }

    for (const file of files) {
      if (appliedSet.has(file)) continue;

      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf-8');

      await this.transaction(async (txQuery) => {
        await txQuery(sql);
        await txQuery('INSERT INTO _decigraph_migrations (name) VALUES (?)', [file]);
      });

      console.warn(`[decigraph/postgres] Migration applied: ${file}`);
    }
  }

  // ---- arrayParam ---------------------------------------------------------

  arrayParam(values: unknown[]): unknown {
    // PostgreSQL handles native JS arrays natively via the pg driver.
    return values;
  }

  // ---- private helpers ----------------------------------------------------

  private _buildPool(): pg.Pool {
    // Prefer config passed explicitly; fall back to environment variables.
    // This mirrors the logic in pool.ts so that existing callers continue to work.
    const connectionString =
      this._config?.connectionString ?? process.env.DATABASE_URL;

    if (!connectionString) {
      console.warn('[decigraph/postgres] WARNING: No connectionString or DATABASE_URL set. Pool will try default pg settings.');
    }

    const useSSL =
      this._config?.ssl ?? process.env.DATABASE_SSL === 'true';

    const pool = new Pool({
      connectionString,
      min: this._config?.poolMin ?? parseInt(process.env.DATABASE_POOL_MIN ?? '2', 10),
      max: this._config?.poolMax ?? parseInt(process.env.DATABASE_POOL_MAX ?? '20', 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ...(useSSL && { ssl: { rejectUnauthorized: true } }),
    });

    pool.on('error', (err) => {
      console.error('[decigraph/postgres] Unexpected pool error:', (err as Error).message);
    });

    return pool;
  }

  private _getPool(): pg.Pool {
    if (this._pool) return this._pool;
    // If connect() was never called, fall back to the shared singleton pool
    // from pool.ts for backward compatibility.
    return getPool(this._config);
  }

  private async _rawQuery<T = Record<string, unknown>>(
    sql: string,
    params: unknown[],
  ): Promise<QueryResult<T>> {
    const pool = this._getPool();
    const result = await pool.query<T & pg.QueryResultRow>(sql, params);
    return {
      rows: result.rows ?? [],
      rowCount: result.rowCount ?? (result.rows?.length ?? 0),
    };
  }
}
