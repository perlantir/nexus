import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DeciGraphClient } from '../../../sdk/src/index.js';
import type { DeciGraphServerConfig } from '../server.js';

export function registerContextTools(
  server: McpServer,
  client: DeciGraphClient,
  config: DeciGraphServerConfig,
): void {
  server.registerTool(
    'decigraph_compile_context',
    {
      title: 'Compile context for a task',
      description:
        'Compiles a ranked, token-budgeted context package of decisions, artifacts, and notifications relevant to the current task. Call this at the start of every significant task.',
      inputSchema: {
        agent_name: z.string().min(1).describe('Name of the agent requesting context.'),
        task_description: z
          .string()
          .min(1)
          .describe('Description of the current task to compile context for.'),
        max_tokens: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Maximum token budget for the compiled context. Defaults to agent budget.'),
      },
    },
    async (args) => {
      const pkg = await client.compileContext({
        agent_name: args.agent_name,
        project_id: config.projectId,
        task_description: args.task_description,
        max_tokens: args.max_tokens,
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                formatted_markdown: pkg.formatted_markdown,
                stats: {
                  token_count: pkg.token_count,
                  budget_used_pct: pkg.budget_used_pct,
                  decisions_considered: pkg.decisions_considered,
                  decisions_included: pkg.decisions_included,
                  compilation_time_ms: pkg.compilation_time_ms,
                },
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
