/**
 * SQLiteAdapter
 *
 * Implements DatabaseAdapter using better-sqlite3 (synchronous API wrapped in
 * an async interface).  Type conversions mirror what the pg driver does
 * automatically for PostgreSQL:
 *
 *   - BOOLEAN (INTEGER 0/1) → boolean
 *   - TIMESTAMPTZ (ISO 8601 TEXT) → string (kept as ISO)
 *   - JSONB / TEXT[] / UUID[] (JSON TEXT) → parsed object / array
 *   - DATE (TEXT) → string
 *
 * SQLite-vec extension is loaded opportunistically for vector search.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type Database from 'better-sqlite3';
import type { DatabaseAdapter, QueryResult, TransactionQueryFn } from './adapter.js';

// ---------------------------------------------------------------------------
// Dynamic require for CJS-only modules
// ---------------------------------------------------------------------------

const _require = createRequire(import.meta.url);

function loadBetterSqlite3(): typeof import('better-sqlite3') {
  return _require('better-sqlite3') as typeof import('better-sqlite3');
}

// ---------------------------------------------------------------------------
// Column name heuristics for type normalisation
// ---------------------------------------------------------------------------

/** Columns that should be parsed as boolean (stored as INTEGER 0/1). */
const BOOLEAN_COLUMNS = new Set([
  'was_useful',
  'enabled',
]);

/**
 * Columns that contain JSON arrays / objects (stored as TEXT).
 * This covers both JSONB and TEXT[] / UUID[] columns.
 */
const JSON_COLUMNS = new Set([
  'metadata',
  'relevance_profile',
  'compiled_context',
  'alternatives_considered',
  'assumptions',
  'open_questions',
  'dependencies',
  'affects',
  'tags',
  'decision_ids',
  'artifact_ids',
  'lessons_learned',
  'notify_on',
  'scopes',
  'related_decision_ids',
  'decision_ids_included',
  'artifact_ids_included',
  'config',
]);

/**
 * Columns that hold ISO 8601 timestamp strings; no transformation is needed
 * here (they are already strings), but we normalise `null` → `undefined` for
 * optional timestamps.
 */
const NULLABLE_TIMESTAMP_COLUMNS = new Set([
  'validated_at',
  'read_at',
  'resolved_at',
  'last_used_at',
  'revoked_at',
  'last_poll_at',
]);

// ---------------------------------------------------------------------------
// Row normalisation
// ---------------------------------------------------------------------------

/**
 * Convert a raw SQLite row into the same shape that the pg driver would return
 * for the equivalent PostgreSQL row.
 */
function normaliseRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined) {
      // Keep nullable timestamps as undefined
      out[key] = NULLABLE_TIMESTAMP_COLUMNS.has(key) ? undefined : null;
      continue;
    }

    if (BOOLEAN_COLUMNS.has(key)) {
      out[key] = value === 1 || value === '1' || value === true;
      continue;
    }

    if (JSON_COLUMNS.has(key)) {
      if (typeof value === 'string') {
        try {
          out[key] = JSON.parse(value);
        } catch {
          out[key] = value; // Malformed JSON — pass through
        }
      } else {
        out[key] = value;
      }
      continue;
    }

    out[key] = value;
  }

  return out;
}

function normaliseRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map(normaliseRow);
}

// ---------------------------------------------------------------------------
// Detect whether a statement is a write (DML) or read (SELECT / PRAGMA …)
// ---------------------------------------------------------------------------

const SELECT_RE = /^\s*(?:SELECT|PRAGMA|WITH\s)/i;
const DML_RE = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE|UPSERT)/i;

function statementReturnsRows(sql: string): boolean {
  return SELECT_RE.test(sql);
}

function statementIsDml(sql: string): boolean {
  return DML_RE.test(sql);
}

// ---------------------------------------------------------------------------
// SQLiteAdapter
// ---------------------------------------------------------------------------

export class SQLiteAdapter implements DatabaseAdapter {
  readonly dialect = 'sqlite' as const;

  private _db: Database.Database | null = null;
  private _vecLoaded = false;
  private readonly _dbPath: string;

  constructor(dbPath: string) {
    this._dbPath = dbPath;
  }

  // ---- connect / close ----------------------------------------------------

  async connect(): Promise<void> {
    if (this._db) return;
    const BetterSqlite3 = loadBetterSqlite3();
    this._db = new BetterSqlite3(this._dbPath);

    // WAL mode — significantly better concurrency for reads during writes.
    this._db.pragma('journal_mode = WAL');
    // Enforce foreign key constraints.
    this._db.pragma('foreign_keys = ON');

    // Attempt to load sqlite-vec for vector search.
    this._tryLoadVec();
  }

  async close(): Promise<void> {
    if (this._db) {
      this._db.close();
      this._db = null;
    }
  }

  // ---- health check -------------------------------------------------------

  async healthCheck(): Promise<boolean> {
    try {
      const db = this._getDb();
      const result = db.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined;
      return result?.ok === 1;
    } catch {
      return false;
    }
  }

  // ---- query --------------------------------------------------------------

  async query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> {
    const db = this._getDb();
    const flatParams = this._flattenParams(params ?? []);

    try {
      const stmt = db.prepare(sql);

      if (statementReturnsRows(sql)) {
        const rows = stmt.all(...flatParams) as Record<string, unknown>[];
        const normalised = normaliseRows(rows) as T[];
        return { rows: normalised, rowCount: normalised.length };
      }

      if (statementIsDml(sql)) {
        const info = stmt.run(...flatParams);
        return { rows: [], rowCount: info.changes };
      }

      // DDL or other non-SELECT, non-DML (CREATE TABLE, DROP, etc.)
      stmt.run(...flatParams);
      return { rows: [], rowCount: 0 };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`[decigraph/sqlite] Query failed: ${message}\nSQL: ${sql.slice(0, 200)}`);
    }
  }

  // ---- transaction --------------------------------------------------------

  async transaction<T>(
    fn: (query: TransactionQueryFn) => Promise<T>,
  ): Promise<T> {
    const db = this._getDb();

    // better-sqlite3's db.transaction() is synchronous, but our interface is
    // async.  We run the async fn inside a Promise and wrap the whole thing
    // in a manual BEGIN / COMMIT / ROLLBACK so we can await the fn properly.

    db.prepare('BEGIN').run();
    try {
      const txQuery: TransactionQueryFn = (sql, params) =>
        this.query(sql, params);

      const result = await fn(txQuery);
      db.prepare('COMMIT').run();
      return result;
    } catch (err) {
      try { db.prepare('ROLLBACK').run(); } catch { /* ignore rollback errors */ }
      throw err;
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
    if (!this._vecLoaded) {
      console.warn(
        '[decigraph/sqlite] sqlite-vec extension not loaded — vector search unavailable. ' +
        'Install sqlite-vec and ensure the shared library is discoverable.',
      );
      return { rows: [], rowCount: 0 };
    }

    // sqlite-vec uses a vec0 virtual table named `${table}_${embeddingColumn}s`
    // by convention.  We query it with a JOIN back to the base table.
    const vecTable = `${table}_embeddings`;

    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (filters) {
      for (const [key, value] of Object.entries(filters)) {
        conditions.push(`t.${key} = ?`);
        params.push(value);
        paramIdx++;
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // sqlite-vec KNN query using vec_distance_cosine
    const sql = `
      SELECT t.*, v.distance
      FROM ${vecTable} AS v
      JOIN ${table} AS t ON t.id = v.${table.replace(/s$/, '')}_id
      ${whereClause}
      WHERE v.${embeddingColumn} MATCH ?
        AND k = ?
      ORDER BY v.distance
    `;
    params.push(JSON.stringify(queryVector), limit);

    try {
      return await this.query(sql, params);
    } catch (err) {
      console.warn(
        `[decigraph/sqlite] vectorSearch failed (${(err as Error).message}). ` +
        'Ensure the vec0 virtual table is created and sqlite-vec is loaded.',
      );
      return { rows: [], rowCount: 0 };
    }
  }

  // ---- runMigrations ------------------------------------------------------

  async runMigrations(migrationsDir: string): Promise<void> {
    // Ensure the tracking table exists.
    await this.query(`
      CREATE TABLE IF NOT EXISTS _decigraph_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    const applied = await this.query<{ name: string }>(
      'SELECT name FROM _decigraph_migrations ORDER BY id',
    );
    const appliedSet = new Set(applied.rows.map((r) => r.name));

    let files: string[];
    try {
      files = fs
        .readdirSync(migrationsDir)
        .filter((f) => f.endsWith('.sql'))
        .sort();
    } catch (err) {
      throw new Error(
        `[decigraph/sqlite] Cannot read migrations directory "${migrationsDir}": ${(err as Error).message}`,
      );
    }

    for (const file of files) {
      if (appliedSet.has(file)) continue;

      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf-8');

      await this.transaction(async (txQuery) => {
        // Execute the full migration SQL (may contain multiple statements).
        this._execScript(sql);
        await txQuery(
          'INSERT INTO _decigraph_migrations (name) VALUES (?)',
          [file],
        );
      });

      console.warn(`[decigraph/sqlite] Migration applied: ${file}`);
    }
  }

  // ---- arrayParam ---------------------------------------------------------

  arrayParam(values: unknown[]): unknown {
    return JSON.stringify(values);
  }

  // ---- private helpers ----------------------------------------------------

  private _getDb(): Database.Database {
    if (!this._db) {
      throw new Error(
        '[decigraph/sqlite] Database not connected. Call connect() before querying.',
      );
    }
    return this._db;
  }

  /**
   * Run a multi-statement SQL script using the exec() API.
   * This is used for migration files that may contain many statements.
   */
  private _execScript(sql: string): void {
    const db = this._getDb();
    db.exec(sql);
  }

  /**
   * Flatten params: convert any nested arrays (produced by arrayParam for
   * nested data that somehow still arrives as an array) to JSON strings, and
   * unwrap any other special values.
   */
  private _flattenParams(params: unknown[]): unknown[] {
    return params.map((p) => {
      if (Array.isArray(p)) return JSON.stringify(p);
      if (p instanceof Date) return p.toISOString();
      return p;
    });
  }

  /**
   * Attempt to load the sqlite-vec native extension.
   * Fails silently — vector search will return empty results if unavailable.
   */
  private _tryLoadVec(): void {
    const db = this._getDb();
    try {
      // Try the npm package first
      let vecPath: string | undefined;
      try {
        const sqliteVec = _require('sqlite-vec') as { getLoadablePath: () => string } | undefined;
        if (sqliteVec && typeof sqliteVec.getLoadablePath === 'function') {
          vecPath = sqliteVec.getLoadablePath();
        }
      } catch {
        // Package not installed — try common system paths
        const candidates = [
          '/usr/local/lib/vec0',
          '/usr/lib/sqlite3/vec0',
        ];
        for (const c of candidates) {
          if (fs.existsSync(`${c}.so`) || fs.existsSync(`${c}.dylib`) || fs.existsSync(`${c}.dll`)) {
            vecPath = c;
            break;
          }
        }
      }

      if (vecPath) {
        db.loadExtension(vecPath);
        this._vecLoaded = true;
        console.warn('[decigraph/sqlite] sqlite-vec extension loaded successfully.');
      }
    } catch (err) {
      console.warn(
        `[decigraph/sqlite] sqlite-vec extension could not be loaded (${(err as Error).message}). ` +
        'Vector search will return empty results.',
      );
    }
  }
}
