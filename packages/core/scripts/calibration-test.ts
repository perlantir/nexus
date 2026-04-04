#!/usr/bin/env tsx
/**
 * Calibration Test — verifies scoring differentiation across agents.
 *
 * Usage: npx tsx packages/core/scripts/calibration-test.ts
 *
 * Runs a compile request for multiple agents with the same task,
 * then prints each agent's top-3 decisions with finalScore,
 * total count returned, and score range (min–max).
 */

import { initDb, getDb, closeDb } from '../src/db/index.js';
import { compileContext } from '../src/context-compiler/index.js';

const TASK = 'Build the Bouts leaderboard API with real-time ELO updates';
const AGENTS = ['maks', 'counsel', 'pixel', 'gauntlet', 'forge', 'chain'];

async function main() {
  console.log('[calibration] Initializing...');
  await initDb();
  const db = getDb();

  // Get first project
  const projResult = await db.query('SELECT id, name FROM projects ORDER BY created_at LIMIT 1', []);
  if (projResult.rows.length === 0) {
    console.error('[calibration] No projects found. Seed data first.');
    process.exit(1);
  }
  const project = projResult.rows[0] as Record<string, unknown>;
  const projectId = project.id as string;
  console.log(`[calibration] Project: ${project.name} (${projectId})`);
  console.log(`[calibration] Task: "${TASK}"\n`);

  for (const agentName of AGENTS) {
    // Check if agent exists
    const agentResult = await db.query(
      'SELECT id FROM agents WHERE project_id = ? AND name = ?',
      [projectId, agentName],
    );
    if (agentResult.rows.length === 0) {
      console.log(`Agent: ${agentName} — NOT FOUND (skipping)\n`);
      continue;
    }

    try {
      const result = await compileContext({
        agent_name: agentName,
        project_id: projectId,
        task_description: TASK,
        max_tokens: 100000, // Large budget to see all results
      });

      const decisions = result.decisions;
      const top3 = decisions.slice(0, 3);
      const scores = decisions.map((d) => d.combined_score);
      const minScore = scores.length > 0 ? Math.min(...scores) : 0;
      const maxScore = scores.length > 0 ? Math.max(...scores) : 0;

      console.log(`Agent: ${agentName}`);
      console.log(`  Top 3: ${top3.map((d) => `[${d.combined_score.toFixed(2)}] ${d.title.slice(0, 40)}`).join(' | ')}`);
      console.log(`  Total returned: ${decisions.length}`);
      console.log(`  Score range: ${minScore.toFixed(2)}–${maxScore.toFixed(2)}`);
      console.log('');
    } catch (err) {
      console.error(`Agent: ${agentName} — ERROR: ${(err as Error).message}\n`);
    }
  }

  await closeDb();
}

main().catch((err) => {
  console.error('[calibration] Fatal error:', err);
  process.exit(1);
});
