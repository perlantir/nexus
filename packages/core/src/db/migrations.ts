import fs from 'node:fs';
import path from 'node:path';
import { query, getClient } from './pool.js';

export async function runMigrations(migrationsDir: string): Promise<void> {
  // Ensure migrations tracking table exists
  await query(`
    CREATE TABLE IF NOT EXISTS _decigraph_migrations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Get already applied migrations
  const applied = await query<{ name: string }>('SELECT name FROM _decigraph_migrations ORDER BY id');
  const appliedSet = new Set(applied.rows.map((r) => r.name));

  // Read migration files
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (appliedSet.has(file)) continue;

    const filePath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(filePath, 'utf-8');

    const client = await getClient();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _decigraph_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.warn(`[decigraph] Migration applied: ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[decigraph] Migration failed: ${file}`, err);
      throw err;
    } finally {
      client.release();
    }
  }
}
