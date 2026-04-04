import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DeciGraphClient } from '../../sdk/src/index.js';
import { registerCaptureTools } from './tools/capture.js';
import { registerDecisionTools } from './tools/decisions.js';
import { registerContextTools } from './tools/context.js';
import { registerGraphTools } from './tools/graph.js';
import { registerSessionTools } from './tools/sessions.js';
import { registerResources } from './resources/index.js';

export interface DeciGraphServerConfig {
  apiUrl: string;
  apiKey?: string;
  projectId: string;
  /** Agent ID used for notification lookups */
  agentId?: string;
}

export function createDeciGraphServer(config: DeciGraphServerConfig): McpServer {
  const client = new DeciGraphClient({
    baseUrl: config.apiUrl,
    apiKey: config.apiKey,
  });

  const server = new McpServer(
    {
      name: 'decigraph',
      version: '0.1.0',
    },
    {
      instructions:
        'DeciGraph decision-memory server. Use decigraph_compile_context at the start of every task to load relevant decisions. Use decigraph_auto_capture or decigraph_record_decision to record important choices.',
    },
  );

  registerCaptureTools(server, client, config);
  registerDecisionTools(server, client, config);
  registerContextTools(server, client, config);
  registerGraphTools(server, client, config);
  registerSessionTools(server, client, config);
  registerResources(server, client, config);

  return server;
}

export { McpServer, StdioServerTransport };
