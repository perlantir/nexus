#!/usr/bin/env node
// Reads config from environment, handles zero-config first-run
// (auto-creates project + default agent), then starts MCP server on stdio.

import path from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DeciGraphClient } from '../../sdk/src/index.js';
import { createDeciGraphServer } from './server.js';

const API_URL = process.env['DECIGRAPH_API_URL'] ?? 'http://localhost:3100';
const API_KEY = process.env['DECIGRAPH_API_KEY'];
let PROJECT_ID = process.env['DECIGRAPH_PROJECT_ID'] ?? '';

// Use stderr to avoid polluting the stdio MCP stream
function log(msg: string): void {
  process.stderr.write(`[decigraph-mcp] ${msg}\n`);
}

function logError(msg: string, err?: unknown): void {
  const detail = err instanceof Error ? err.message : String(err ?? '');
  process.stderr.write(`[decigraph-mcp] ERROR: ${msg}${detail ? ` — ${detail}` : ''}\n`);
}

async function ensureProject(client: DeciGraphClient): Promise<string> {
  if (PROJECT_ID) {
    try {
      await client.getProject(PROJECT_ID);
      log(`Using project: ${PROJECT_ID}`);
      return PROJECT_ID;
    } catch (err) {
      logError(`Could not load project ${PROJECT_ID}`, err);
      throw err;
    }
  }

  // Auto-create a project named after the current working directory
  const projectName = path.basename(process.cwd());
  log(`No DECIGRAPH_PROJECT_ID set. Creating project "${projectName}"...`);

  const project = await client.createProject({
    name: projectName,
    description: `Auto-created by decigraph-mcp for directory: ${process.cwd()}`,
    metadata: {
      auto_created: true,
      cwd: process.cwd(),
      created_by: 'decigraph-mcp',
    },
  });

  log(`Project created: ${project.id} (name: "${project.name}")`);
  log(`\n  ╔══════════════════════════════════════════╗`);
  log(`  ║  Save your project ID for future use:    ║`);
  log(`  ║  DECIGRAPH_PROJECT_ID=${project.id}  ║`);
  log(`  ╚══════════════════════════════════════════╝\n`);

  return project.id;
}

async function ensureDefaultAgent(client: DeciGraphClient, projectId: string): Promise<string> {
  try {
    const agents = await client.listAgents(projectId);
    const existing = agents.find((a) => a.name === 'developer' || a.role === 'builder');
    if (existing) {
      log(`Using existing agent: ${existing.id} (${existing.name})`);
      return existing.id;
    }
  } catch (err) {
    logError('Could not list agents, will attempt to create default agent', err);
  }

  log('Registering default "developer" agent with builder role...');

  const agent = await client.createAgent(projectId, {
    name: 'developer',
    role: 'builder',
    context_budget_tokens: 8000,
  });

  log(`Default agent created: ${agent.id} (${agent.name} / ${agent.role})`);
  return agent.id;
}

async function main(): Promise<void> {
  log(`Starting DeciGraph MCP server`);
  log(`API URL: ${API_URL}`);

  const client = new DeciGraphClient({
    baseUrl: API_URL,
    apiKey: API_KEY,
  });

  // Verify API reachability; tools will fail gracefully if unreachable
  try {
    const health = await client.health();
    log(`API healthy: ${health.status} (v${health.version})`);
  } catch (err) {
    logError(`Cannot reach DeciGraph API at ${API_URL}. Is the server running?`, err);
  }

  PROJECT_ID = await ensureProject(client);
  const agentId = await ensureDefaultAgent(client, PROJECT_ID);

  const server = createDeciGraphServer({
    apiUrl: API_URL,
    apiKey: API_KEY,
    projectId: PROJECT_ID,
    agentId,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log(`DeciGraph MCP server running on stdio (project: ${PROJECT_ID})`);
}

main().catch((err: unknown) => {
  logError('Fatal error during startup', err);
  process.exit(1);
});
