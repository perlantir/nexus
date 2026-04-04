import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DeciGraphClient } from '../../../sdk/src/index.js';
import type { DeciGraphServerConfig } from '../server.js';

export function registerGraphTools(
  server: McpServer,
  client: DeciGraphClient,
  config: DeciGraphServerConfig,
): void {
  server.registerTool(
    'decigraph_get_graph',
    {
      title: 'Get decision graph',
      description:
        'Returns the decision graph rooted at a specific decision, including related decisions and edge relationships.',
      inputSchema: {
        decision_id: z.string().min(1).describe('The root decision ID to traverse from.'),
        depth: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe('Traversal depth. Defaults to 2.'),
      },
    },
    async (args) => {
      const graph = await client.getGraph(args.decision_id, args.depth);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                nodes: graph.nodes,
                edges: graph.edges,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'decigraph_get_impact',
    {
      title: 'Get impact analysis',
      description:
        'Analyzes the downstream impact of a decision: which decisions depend on it, which agents are affected, and whether it blocks others.',
      inputSchema: {
        decision_id: z.string().min(1).describe('The ID of the decision to analyze.'),
      },
    },
    async (args) => {
      const impact = await client.getImpact(args.decision_id);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                downstream_decisions: impact.downstream_decisions,
                affected_agents: impact.affected_agents,
                cached_contexts_invalidated: impact.cached_contexts_invalidated,
                blocking_decisions: impact.blocking_decisions,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'decigraph_get_contradictions',
    {
      title: 'Get contradictions',
      description: 'Retrieves detected contradictions between decisions in the project.',
      inputSchema: {
        status: z
          .enum(['unresolved', 'resolved', 'all'])
          .optional()
          .describe('Filter by contradiction status. Defaults to unresolved.'),
      },
    },
    async (args) => {
      const statusFilter = args.status === 'all' ? undefined : (args.status ?? 'unresolved');

      const contradictions = await client.getContradictions(
        config.projectId,
        statusFilter === 'unresolved'
          ? 'unresolved'
          : statusFilter === 'resolved'
            ? 'resolved'
            : undefined,
      );

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(contradictions, null, 2),
          },
        ],
      };
    },
  );
}
