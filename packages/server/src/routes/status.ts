import type { Hono } from 'hono';
import { getDb } from '@decigraph/core/db/index.js';
import { resolveLLMConfig } from '@decigraph/core/config/llm.js';
import { getQueueStats, isQueueEnabled } from '../queue/index.js';
import { getTelegramStatus } from '../connectors/telegram.js';
import { getOpenClawStatus } from '../connectors/openclaw-watcher.js';
import { getDiscordStatus } from '../connectors/discord.js';
import { getSlackStatus } from '../connectors/slack.js';

export function registerStatusRoutes(app: Hono): void {
  // POST /api/cache/clear — manually flush the context cache.
  // Useful after deploys, scoring changes, or debugging scored=0 issues.
  app.post('/api/cache/clear', async (c) => {
    const db = getDb();
    try {
      const result = await db.query('DELETE FROM context_cache', []);
      const deleted = result.rowCount ?? 0;
      console.warn(`[decigraph] Cache cleared manually: ${deleted} entries removed`);
      return c.json({ cleared: deleted, timestamp: new Date().toISOString() });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // /api/status — system diagnostics (separate from /api/health which load balancers use)
  app.get('/api/status', async (c) => {
    const db = getDb();
    const llm = resolveLLMConfig();

    const [projects, agents, decisions] = await Promise.all([
      db.query('SELECT COUNT(*) as c FROM projects', []).catch(() => ({ rows: [{ c: 0 }] })),
      db.query("SELECT COUNT(*) as c FROM agents WHERE role != 'inactive'", []).catch(() => ({ rows: [{ c: 0 }] })),
      db.query('SELECT COUNT(*) as c FROM decisions', []).catch(() => ({ rows: [{ c: 0 }] })),
    ]);

    const projectCount = parseInt((projects.rows[0] as Record<string, unknown>)?.c as string ?? '0', 10);
    const agentCount = parseInt((agents.rows[0] as Record<string, unknown>)?.c as string ?? '0', 10);
    const decisionCount = parseInt((decisions.rows[0] as Record<string, unknown>)?.c as string ?? '0', 10);

    // Check if embeddings are configured
    const hasEmbeddings = !!(process.env.OPENAI_API_KEY || process.env.DECIGRAPH_EMBEDDINGS_URL);

    // Check how many decisions have embeddings
    let decisionsWithEmbeddings = 0;
    try {
      const embResult = await db.query(
        'SELECT COUNT(*) as c FROM decisions WHERE embedding IS NOT NULL',
        [],
      );
      decisionsWithEmbeddings = parseInt((embResult.rows[0] as Record<string, unknown>)?.c as string ?? '0', 10);
    } catch { /* embedding column may not exist */ }

    // Check stale cache entries
    let cacheEntries = 0;
    try {
      const cacheResult = await db.query('SELECT COUNT(*) as c FROM context_cache', []);
      cacheEntries = parseInt((cacheResult.rows[0] as Record<string, unknown>)?.c as string ?? '0', 10);
    } catch { /* table may not exist */ }

    // Queue + connector stats
    let queueStats: Record<string, unknown> = { enabled: false };
    try {
      queueStats = await getQueueStats();
    } catch { /* ignore */ }

    // Phase 2 Intelligence stats
    let contradictionsOpen = 0;
    let contradictionsResolved = 0;
    let staleCount = 0;
    let duplicateCount = 0;
    let edgesCount = 0;

    try {
      const contrOpen = await db.query("SELECT COUNT(*) as c FROM phase2_contradictions WHERE status = 'open'", []);
      contradictionsOpen = parseInt((contrOpen.rows[0] as Record<string, unknown>)?.c as string ?? '0', 10);
      const contrResolved = await db.query("SELECT COUNT(*) as c FROM phase2_contradictions WHERE status IN ('resolved', 'dismissed')", []);
      contradictionsResolved = parseInt((contrResolved.rows[0] as Record<string, unknown>)?.c as string ?? '0', 10);
    } catch { /* tables may not exist yet */ }

    try {
      const staleRes = await db.query('SELECT COUNT(*) as c FROM decisions WHERE stale = true', []);
      staleCount = parseInt((staleRes.rows[0] as Record<string, unknown>)?.c as string ?? '0', 10);
    } catch { /* column may not exist yet */ }

    try {
      const dupRes = await db.query('SELECT COUNT(*) as c FROM decisions WHERE potential_duplicate_of IS NOT NULL', []);
      duplicateCount = parseInt((dupRes.rows[0] as Record<string, unknown>)?.c as string ?? '0', 10);
    } catch { /* column may not exist yet */ }

    try {
      const edgeRes = await db.query('SELECT COUNT(*) as c FROM phase2_decision_edges', []);
      edgesCount = parseInt((edgeRes.rows[0] as Record<string, unknown>)?.c as string ?? '0', 10);
    } catch { /* table may not exist yet */ }

    return c.json({
      status: 'ok',
      version: '0.2.0',
      timestamp: new Date().toISOString(),
      system: {
        projects: projectCount,
        agents: agentCount,
        decisions: decisionCount,
        decisions_with_embeddings: decisionsWithEmbeddings,
        cache_entries: cacheEntries,
        embeddings: hasEmbeddings,
        distillery: llm.distillery?.model ?? "not configured",
        queues: queueStats,
        telegram: getTelegramStatus(),
        openclaw: getOpenClawStatus(),
        discord: getDiscordStatus(),
        slack: getSlackStatus(),
      },
      intelligence: {
        contradictions: { open: contradictionsOpen, resolved: contradictionsResolved },
        stale_count: staleCount,
        duplicate_count: duplicateCount,
        edges_count: edgesCount,
      },
    });
  });
}

/**
 * Log startup diagnostics — call AFTER server starts listening.
 */
export async function logStartupDiagnostics(): Promise<void> {
  try {
    const db = getDb();
    const llm = resolveLLMConfig();

    const [projects, agents, decisions, agentNames] = await Promise.all([
      db.query('SELECT COUNT(*) as c FROM projects', []).catch(() => ({ rows: [{ c: 0 }] })),
      db.query("SELECT COUNT(*) as c FROM agents WHERE role != 'inactive'", []).catch(() => ({ rows: [{ c: 0 }] })),
      db.query('SELECT COUNT(*) as c FROM decisions', []).catch(() => ({ rows: [{ c: 0 }] })),
      db.query("SELECT name FROM agents WHERE role != 'inactive' ORDER BY name", []).catch(() => ({ rows: [] })),
    ]);

    const pCount = parseInt((projects.rows[0] as Record<string, unknown>)?.c as string ?? '0', 10);
    const aCount = parseInt((agents.rows[0] as Record<string, unknown>)?.c as string ?? '0', 10);
    const dCount = parseInt((decisions.rows[0] as Record<string, unknown>)?.c as string ?? '0', 10);
    const names = agentNames.rows.map((r) => (r as Record<string, unknown>).name).join(', ');
    const hasEmb = !!(process.env.OPENAI_API_KEY || process.env.DECIGRAPH_EMBEDDINGS_URL);

    console.warn('[decigraph] === Startup Diagnostics ===');
    console.warn(`[decigraph]   Projects: ${pCount}`);
    console.warn(`[decigraph]   Agents: ${aCount}${names ? ` (${names})` : ''}`);
    console.warn(`[decigraph]   Decisions: ${dCount}`);
    console.warn(`[decigraph]   Embeddings: ${hasEmb ? 'enabled' : 'disabled'}`);
    console.warn(`[decigraph]   Distillery: ${llm.distillery?.model ?? 'not configured'}`);
    console.warn('[decigraph]   Compile route: registered');
    console.warn('[decigraph] === Ready ===');
  } catch (err) {
    console.warn('[decigraph] Startup diagnostics failed:', (err as Error).message);
  }
}
