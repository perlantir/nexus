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
import { phase3AuthMiddleware, optionalAuth, freeTierOrAuth, isAuthRequired } from './auth/middleware.js';
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
import { registerPhase2ContradictionRoutes } from './routes/phase2-contradictions.js';
import { registerPhase2EdgeRoutes } from './routes/phase2-edges.js';
import { registerImpactRoutes } from './routes/impact.js';
import { registerSlackConnector } from './connectors/slack.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerApiKeyRoutes } from './routes/api-keys.js';
import { registerTeamRoutes } from './routes/team.js';
import { registerAuditLogRoutes } from './routes/audit-log.js';

export function createApp() {
  const app = new Hono();

  // Global middleware stack
  app.use('*', requestTimer);
  app.use('*', securityHeaders);
  app.use('*', corsMiddleware);
  app.use('*', bodyLimit({ maxBytes: 2 * 1024 * 1024 }));

  // ── Phase 3: Global rate limiting ─────────────────────────────────
  // Unauthenticated: 60/min, Authenticated: 300/min (enforced in middleware)
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

  // ── Phase 3: Auth middleware ───────────────────────────────────────
  // When DECIGRAPH_AUTH_REQUIRED=false (default), optionalAuth is used.
  // When true, phase3AuthMiddleware enforces JWT or API key.
  // Public routes are always exempt.
  app.use('/api/*', async (c, next) => {
    const path = c.req.path;

    // Always public
    if (
      path === '/api/health' ||
      path === '/api/status' ||
      path === '/api/cache/clear' ||
      path === '/api/docs' ||
      path === '/api/openapi.json' ||
      path.startsWith('/api/auth/') ||
      path.startsWith('/api/team/invite/') ||
      path === '/api/webhooks/github' ||
      path === '/api/webhooks/slack/events' ||
      path === '/api/webhooks/slack/commands'
    ) {
      await next();
      return;
    }

    // /api/compile uses free tier when auth is required
    if (path === '/api/compile') {
      await freeTierOrAuth(c, next);
      return;
    }

    // /api/distill/ask — same free tier logic
    if (path === '/api/distill/ask') {
      await freeTierOrAuth(c, next);
      return;
    }

    // All other /api/* routes
    if (isAuthRequired()) {
      await phase3AuthMiddleware(c, next);
    } else {
      // Legacy: optionalAuth attaches user if token present, defaults to nick tenant
      // Then fall through to original authMiddleware for DECIGRAPH_API_KEY compat
      await optionalAuth(c, async () => {
        if (process.env.DECIGRAPH_API_KEY) {
          await authMiddleware(c, next);
        } else {
          await next();
        }
      });
    }
  });

  // Health
  app.get('/api/health', (c) => {
    return c.json({ status: 'ok', version: '0.1.0', timestamp: new Date().toISOString() });
  });

  // ── Phase 3: Auth, Team, API Key, Audit Log routes ────────────────
  registerAuthRoutes(app);
  registerApiKeyRoutes(app);
  registerTeamRoutes(app);
  registerAuditLogRoutes(app);

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
  registerPhase2ContradictionRoutes(app);
  registerPhase2EdgeRoutes(app);
  registerImpactRoutes(app);
  registerSlackConnector(app);

  return app;
}

export default createApp();
