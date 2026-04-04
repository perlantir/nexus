import type { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Load the OpenAPI spec at startup
// ---------------------------------------------------------------------------

let openApiSpec: Record<string, unknown> | null = null;

function loadSpec(): Record<string, unknown> {
  if (openApiSpec) return openApiSpec;

  // Try multiple locations (workspace root vs installed package)
  const candidates = [
    resolve(dirname(fileURLToPath(import.meta.url)), '../../../../docs/openapi.json'),
    resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/openapi.json'),
    resolve(process.cwd(), 'docs/openapi.json'),
  ];

  for (const path of candidates) {
    try {
      const raw = readFileSync(path, 'utf-8');
      openApiSpec = JSON.parse(raw);
      return openApiSpec!;
    } catch {
      // try next
    }
  }

  // Fallback: return minimal spec
  openApiSpec = {
    openapi: '3.1.0',
    info: { title: 'Nexus API', version: '1.0.0' },
    paths: {},
  };
  return openApiSpec;
}

// ---------------------------------------------------------------------------
// Swagger UI HTML
// ---------------------------------------------------------------------------

function swaggerHtml(specUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nexus API Docs</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css">
  <style>
    body { margin: 0; background: #fafafa; }
    .topbar { display: none; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: '${specUrl}',
      dom_id: '#swagger-ui',
      presets: [SwaggerUIBundle.presets.apis],
      layout: 'BaseLayout',
      deepLinking: true,
      defaultModelsExpandDepth: 1,
      docExpansion: 'list',
    });
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerDocsRoutes(app: Hono): void {
  // Serve the OpenAPI JSON spec (no auth)
  app.get('/api/openapi.json', (c) => {
    return c.json(loadSpec());
  });

  // Serve Swagger UI (no auth)
  app.get('/api/docs', (c) => {
    return c.html(swaggerHtml('/api/openapi.json'));
  });
}
