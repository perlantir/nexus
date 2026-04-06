import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DeciGraphClient } from '../../sdk/src/index.js';
import { registerAllTools } from './tools.js';

export interface DeciGraphServerConfig {
  apiUrl: string;
  apiKey?: string;
  projectId: string;
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
        'DeciGraph decision-memory server. Use compile_context at the start of every task to load relevant decisions. Use add_decision to record choices. Use ask_decisions for natural language queries.',
    },
  );

  registerAllTools(server, client, { projectId: config.projectId });

  return server;
}

export { McpServer, StdioServerTransport };
