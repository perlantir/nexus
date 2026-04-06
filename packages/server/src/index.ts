import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app.js';
import { logStartupDiagnostics } from './routes/status.js';
import { initDb, closeDb } from '@decigraph/core/db/index.js';
import { resolveLLMConfig, logLLMConfig } from '@decigraph/core';
import { initQueues, closeQueues } from './queue/index.js';
import { handleExtractionJob } from './queue/extraction-worker.js';
import { handleIngestionJob } from './queue/ingestion-worker.js';
import { startTelegramBot, stopTelegramBot, handleTelegramNotification } from './connectors/telegram.js';
import { startOpenClawWatcher, stopOpenClawWatcher } from './connectors/openclaw-watcher.js';
import { registerGitHubWebhook } from './connectors/github.js';
import type { NotificationJobData } from './queue/index.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const PORT = parseInt(process.env.PORT ?? '3100', 10);
const HOST = process.env.HOST ?? '0.0.0.0';
const NODE_ENV = process.env.NODE_ENV ?? 'production';

// ESM-compatible __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Locate the dashboard dist directory by checking several candidate paths.
 * Returns the directory path (containing index.html) or null when not found.
 */
function resolveDashboardPath(): string | null {
  const candidates = [
    path.resolve(__dirname, '..', '..', 'dashboard', 'dist'),
    path.resolve(__dirname, '..', '..', '..', 'dashboard', 'dist'),
    path.resolve(process.cwd(), 'dashboard'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return null;
}

async function main() {
  // Validate required environment
  if (!process.env.DATABASE_URL) {
    console.error('[decigraph] FATAL: DATABASE_URL environment variable is not set.');
    console.error('[decigraph] Set it in .env or docker-compose.yml:');
    console.error('  DATABASE_URL=postgresql://nexus:nexus_dev@postgres:5432/nexus');
    process.exit(1);
  }

  // Auto-detect and connect to the database (SQLite or PostgreSQL).
  let db;
  try {
    db = await initDb();
    console.warn(`[decigraph] Database connected (${db.dialect})`);
  } catch (e: unknown) {
    const err = e instanceof Error ? e : new Error(String(e));
    console.error('[decigraph] FATAL: Cannot connect to database:', err.message);
    if (process.env.NODE_ENV !== 'production') {
      console.error('[decigraph] Stack trace:', err.stack);
    }
    process.exit(1);
  }

  // Verify data exists (warn if empty — may indicate wrong volume)
  try {
    const { rows } = await db.query('SELECT count(*) as c FROM decisions', []);
    const count = parseInt((rows[0] as Record<string, unknown>)?.c as string ?? '0', 10);
    if (count === 0) {
      console.warn('[decigraph] WARNING: Database has 0 decisions. If you expected data, check your Docker volume.');
    } else {
      console.warn(`[decigraph] Database contains ${count} decisions`);
    }
  } catch { /* table may not exist yet — migrations will create it */ }

  // Clear context cache on startup — prevents stale cached results from a
  // previous deployment (e.g. after a revert or scoring algorithm change)
  // from poisoning fresh compile calls.
  try {
    const delResult = await db.query('DELETE FROM context_cache', []);
    const deleted = delResult.rowCount ?? 0;
    if (deleted > 0) {
      console.warn(`[decigraph] Cleared ${deleted} stale context_cache entries on startup`);
    }
  } catch { /* table may not exist yet */ }

  logLLMConfig(resolveLLMConfig());

  // ── Initialize job queues ──────────────────────────────────────────────
  const notificationHandler = async (data: NotificationJobData): Promise<void> => {
    // Route notifications to the appropriate connector
    if (data.source === 'telegram') {
      await handleTelegramNotification(data);
    }
    // Additional notification handlers (webhooks, etc.) can be added here
  };

  const queueEnabled = await initQueues(
    handleExtractionJob,
    handleIngestionJob,
    notificationHandler,
  );
  console.warn(`[decigraph] Queue: ${queueEnabled ? 'BullMQ (Redis connected)' : 'inline mode (Redis not configured)'}`);

  // ── Start connectors ──────────────────────────────────────────────────
  const telegramStarted = startTelegramBot();

  const openclawStarted = startOpenClawWatcher();
  if (!openclawStarted && !telegramStarted) {
    console.warn('[decigraph] Auto-discovery: no connectors configured');
  }

  // Log contradiction detection
  console.warn('[decigraph] Contradiction detection: enabled (semantic threshold: 0.75)');

  const app = createApp();

  // ── Register GitHub PR webhook ──────────────────────────────────────────
  registerGitHubWebhook(app);
  if (process.env.DECIGRAPH_GITHUB_WEBHOOK_SECRET) {
    console.warn('[decigraph] GitHub PR webhook: active');
  }

  // Serve the dashboard static files when they are available (non-Docker mode).
  const dashboardDist = resolveDashboardPath();
  if (dashboardDist) {
    app.get('/dashboard/*', serveStatic({ root: dashboardDist }));
    app.get('/dashboard', (c) => c.redirect('/dashboard/'));
    console.warn(`[decigraph] Dashboard: http://${HOST}:${PORT}/dashboard`);
  }

  const server = serve(
    {
      fetch: app.fetch,
      port: PORT,
      hostname: HOST,
    },
    (info) => {
      console.warn(`[decigraph] Server started`);
      console.warn(`[decigraph] Listening on http://${HOST}:${info.port}`);
      console.warn(`[decigraph] Environment: ${NODE_ENV}`);
      // Log system diagnostics after startup
      logStartupDiagnostics().catch(() => {});
    },
  );

  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.warn(`\n[decigraph] Received ${signal}. Shutting down gracefully...`);

    // Stop connectors first
    stopTelegramBot();
    await stopOpenClawWatcher();
    await closeQueues();

    server.close(async () => {
      console.warn('[decigraph] HTTP server closed');

      try {
        await closeDb();
        console.warn('[decigraph] Database closed');
      } catch (err) {
        console.error('[decigraph] Error closing database:', (err as Error).message);
      }

      console.warn('[decigraph] Shutdown complete');
      process.exit(0);
    });

    // Force exit if graceful shutdown takes too long
    setTimeout(() => {
      console.error('[decigraph] Forced shutdown after timeout');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    console.error('[decigraph] Uncaught exception:', err);
    void shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    console.error('[decigraph] Unhandled rejection:', reason);
  });
}

main().catch((err) => {
  console.error('[decigraph] Fatal startup error:', err);
  process.exit(1);
});
