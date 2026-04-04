#!/usr/bin/env tsx
/**
 * Backfill embeddings for all decisions that have null/zero-vector embeddings.
 *
 * Usage: npx tsx packages/core/scripts/backfill-embeddings.ts
 *
 * Processes in batches of 50, shows progress, and is idempotent
 * (skips decisions that already have non-zero embeddings).
 */

import { initDb, getDb, closeDb } from '../src/db/index.js';
import { generateEmbedding } from '../src/decision-graph/embeddings.js';

const BATCH_SIZE = 50;

async function isZeroVector(embedding: unknown): Promise<boolean> {
  if (!embedding) return true;
  const arr = typeof embedding === 'string' ? JSON.parse(embedding) : embedding;
  if (!Array.isArray(arr) || arr.length === 0) return true;
  return arr.every((v: number) => v === 0);
}

async function main() {
  console.log('[backfill] Initializing database...');
  await initDb();
  const db = getDb();

  // Get total count of decisions needing backfill
  const countResult = await db.query('SELECT COUNT(*) as count FROM decisions', []);
  const total = parseInt((countResult.rows[0] as Record<string, unknown>).count as string, 10);
  console.log(`[backfill] Total decisions: ${total}`);

  let processed = 0;
  let skipped = 0;
  let updated = 0;
  let failed = 0;
  let offset = 0;

  while (offset < total) {
    const batch = await db.query(
      'SELECT id, title, description, reasoning, embedding FROM decisions ORDER BY created_at LIMIT ? OFFSET ?',
      [BATCH_SIZE, offset],
    );

    if (batch.rows.length === 0) break;

    for (const row of batch.rows) {
      const d = row as Record<string, unknown>;
      processed++;

      // Skip if already has a non-zero embedding
      if (d.embedding && !(await isZeroVector(d.embedding))) {
        skipped++;
        continue;
      }

      const text = `${d.title}\n${d.description}\n${d.reasoning}`;

      try {
        const embedding = await generateEmbedding(text);

        // Check if it's a real embedding (not zero-vector)
        if (embedding.every((v) => v === 0)) {
          console.warn(`  [${processed}/${total}] ${(d.title as string).slice(0, 50)} — zero-vector (no provider?)`);
          failed++;
          continue;
        }

        await db.query('UPDATE decisions SET embedding = ? WHERE id = ?', [
          `[${embedding.join(',')}]`,
          d.id,
        ]);
        updated++;

        if (updated % 10 === 0) {
          console.log(`  [${processed}/${total}] ${updated} updated, ${skipped} skipped, ${failed} failed`);
        }
      } catch (err) {
        failed++;
        console.error(`  [${processed}/${total}] ${(d.title as string).slice(0, 50)} — ERROR: ${(err as Error).message}`);
      }

      // Small delay to avoid rate limiting
      if (updated % 10 === 0) await new Promise((r) => setTimeout(r, 100));
    }

    offset += BATCH_SIZE;
  }

  console.log(`\n[backfill] Done.`);
  console.log(`  Total:   ${total}`);
  console.log(`  Updated: ${updated}`);
  console.log(`  Skipped: ${skipped} (already had embeddings)`);
  console.log(`  Failed:  ${failed}`);

  await closeDb();
}

main().catch((err) => {
  console.error('[backfill] Fatal error:', err);
  process.exit(1);
});
