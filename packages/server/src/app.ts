import { Hono } from 'hono';
// Auditing strategy: route-level logAudit() calls are used for targeted
// logging of important operations (decision CRUD, compile, validate, etc.).
// Per-request auditMiddleware is intentionally not mounted — it would log
// every GET request which is noisy and provides little value.
import {
  errorHandler,
  authMiddleware,
  corsMiddleware,
  requestTimer,
  securityHeaders,
  rateLimiter,
  bodyLimit,
} from './middleware/index.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerAgentRoutes } from './routes/agents.js';
import { registerDecisionRoutes } from './routes/decisions.js';
import { registerCompileRoutes } from './routes/compile.js';
import { registerDistilleryRoutes } from './routes/distillery.js';
import { registerNotificationRoutes } from './routes/notifications.js';
import { registerContradictionRoutes } from './routes/contradictions.js';
import { registerFeedbackRoutes } from './routes/feedback.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerStatsRoutes } from './routes/stats.js';
import { registerArtifactRoutes } from './routes/artifacts.js';
import { registerDiscoveryRoutes } from './routes/discovery.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { registerExportImportRoutes } from './routes/export-import.js';
import { registerDocsRoutes } from './routes/docs.js';
import { registerTimeTravelRoutes } from './routes/time-travel.js';
import { registerReviewRoutes } from './routes/review.js';
import { registerStatusRoutes } from './routes/status.js';

export function createApp() {
  const app = new Hono();

  // Global middleware stack
  app.use('*', requestTimer);
  app.use('*', securityHeaders);
  app.use('*', corsMiddleware);
  app.use('*', bodyLimit({ maxBytes: 2 * 1024 * 1024 }));
  app.use('/api/*', rateLimiter({ maxRequests: 100 }));
  app.use('/api/compile', rateLimiter({ maxRequests: 30, windowMs: 60000, namespace: 'compile' }));
  app.use(
    '/api/*/distill*',
    rateLimiter({ maxRequests: 10, windowMs: 60000, namespace: 'distill' }),
  );
  app.use(
    '/api/*/decisions',
    rateLimiter({ maxRequests: 60, windowMs: 60000, namespace: 'decisions' }),
  );
  app.onError(errorHandler);

  // Auth on all /api/* except /api/health, /api/docs, /api/openapi.json
  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/health' || c.req.path === '/api/status' || c.req.path === '/api/cache/clear' || c.req.path === '/api/distill/ask' || c.req.path === '/api/webhooks/github' || c.req.path === '/api/docs' || c.req.path === '/api/openapi.json') {
      await next();
      return;
    }
    await authMiddleware(c, next);
  });

  // Health
  app.get('/api/health', (c) => {
    return c.json({ status: 'ok', version: '0.1.0', timestamp: new Date().toISOString() });
  });

  // Register route modules
  registerProjectRoutes(app);
  registerAgentRoutes(app);
  registerDecisionRoutes(app);
  registerCompileRoutes(app);
  registerDistilleryRoutes(app);
  registerNotificationRoutes(app);
  registerContradictionRoutes(app);
  registerFeedbackRoutes(app);
  registerAuditRoutes(app);
  registerStatsRoutes(app);
  registerArtifactRoutes(app);
  registerDiscoveryRoutes(app);
  registerWebhookRoutes(app);
  registerExportImportRoutes(app);
  registerDocsRoutes(app);
  registerTimeTravelRoutes(app);
  registerReviewRoutes(app);
  registerStatusRoutes(app);

  return app;
}

export default createApp();
