import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DeciGraphClient } from '../../../sdk/src/index.js';
import type { DeciGraphServerConfig } from '../server.js';

export function registerDecisionTools(
  server: McpServer,
  client: DeciGraphClient,
  config: DeciGraphServerConfig,
): void {
  server.registerTool(
    'decigraph_record_decision',
    {
      title: 'Record a decision',
      description:
        'Manually records an important decision into the DeciGraph knowledge graph. Use this for explicit architectural, product, or implementation decisions.',
      inputSchema: {
        title: z.string().min(1).describe('Short, descriptive title for the decision.'),
        description: z.string().min(1).describe('What was decided and the full context.'),
        reasoning: z.string().min(1).describe('Why this decision was made.'),
        tags: z
          .array(z.string())
          .describe('Relevant domain tags (e.g. architecture, api, security, database, product).'),
        affects: z
          .array(z.string())
          .describe('List of components, systems, or agents this decision affects.'),
        confidence: z
          .enum(['high', 'medium', 'low'])
          .optional()
          .describe('Confidence level for this decision. Defaults to medium.'),
        alternatives: z
          .array(
            z.object({
              option: z.string(),
              rejected_reason: z.string(),
            }),
          )
          .optional()
          .describe('Alternative options that were considered and rejected.'),
        assumptions: z
          .array(z.string())
          .optional()
          .describe('Assumptions this decision relies on.'),
        open_questions: z
          .array(z.string())
          .optional()
          .describe('Unresolved questions related to this decision.'),
      },
    },
    async (args) => {
      const decision = await client.createDecision(config.projectId, {
        title: args.title,
        description: args.description,
        reasoning: args.reasoning,
        made_by: config.agentId ?? 'mcp-agent',
        tags: args.tags,
        affects: args.affects,
        confidence: args.confidence,
        alternatives_considered: args.alternatives,
        assumptions: args.assumptions,
        open_questions: args.open_questions,
        source: 'manual',
      });

      // Check for contradictions via impact analysis (best-effort)
      let contradictions: unknown[] = [];
      try {
        const impact = await client.getImpact(decision.id);
        contradictions = impact.downstream_decisions.filter((d) => d.status === 'active');
      } catch {
        // Impact analysis is best-effort
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                decision_id: decision.id,
                status: decision.status,
                contradictions,
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
    'decigraph_list_decisions',
    {
      title: 'List decisions',
      description:
        'Lists project decisions with optional filters. Returns a structured list including status, tags, and made_by fields.',
      inputSchema: {
        status: z
          .enum(['active', 'superseded', 'reverted', 'pending'])
          .optional()
          .describe('Filter by decision status.'),
        tags: z
          .array(z.string())
          .optional()
          .describe('Filter decisions that have any of these tags.'),
        made_by: z
          .string()
          .optional()
          .describe('Filter by the agent or person who made the decision.'),
        limit: z
          .number()
          .int()
          .positive()
          .max(200)
          .optional()
          .describe('Maximum number of decisions to return. Defaults to 50.'),
      },
    },
    async (args) => {
      const decisions = await client.listDecisions(config.projectId, {
        status: args.status,
        tags: args.tags,
        made_by: args.made_by,
        limit: args.limit,
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(decisions, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    'decigraph_search_decisions',
    {
      title: 'Search decisions',
      description:
        'Semantic search across all project decisions. Returns decisions ranked by relevance to the query.',
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe('Natural-language search query describing what you are looking for.'),
        status: z
          .enum(['active', 'superseded', 'reverted', 'pending'])
          .optional()
          .describe('Filter by decision status.'),
        tags: z.array(z.string()).optional().describe('Filter by one or more domain tags.'),
        limit: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe('Maximum number of results to return. Defaults to 20.'),
      },
    },
    async (args) => {
      const decisions = await client.searchDecisions(config.projectId, args.query, args.limit);

      // Client-side filter by status/tags (search endpoint returns all statuses)
      const filtered = decisions.filter((d) => {
        if (args.status && d.status !== args.status) return false;
        if (args.tags?.length) {
          const tagSet = new Set(d.tags);
          if (!args.tags.some((t) => tagSet.has(t))) return false;
        }
        return true;
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(filtered, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    'decigraph_supersede_decision',
    {
      title: 'Supersede a decision',
      description:
        'Replaces an existing decision with a new one. The old decision is marked as superseded and a graph edge is created. Use this when a decision has changed or been overridden.',
      inputSchema: {
        old_decision_id: z.string().min(1).describe('The ID of the decision being superseded.'),
        title: z.string().min(1).describe('Title of the new superseding decision.'),
        description: z.string().min(1).describe('Full description of the new decision.'),
        reasoning: z.string().min(1).describe('Why the old decision is being replaced.'),
        made_by: z.string().min(1).describe('Agent or person making this new decision.'),
        tags: z.array(z.string()).optional().describe('Domain tags for the new decision.'),
        affects: z
          .array(z.string())
          .optional()
          .describe('Components or systems the new decision affects.'),
      },
    },
    async (args) => {
      const result = await client.supersedeDecision(args.old_decision_id, {
        title: args.title,
        description: args.description,
        reasoning: args.reasoning,
        made_by: args.made_by,
        tags: args.tags,
        affects: args.affects,
      });

      // Notify affected agents via impact analysis (best-effort)
      let agents_notified: string[] = [];
      try {
        const impact = await client.getImpact(result.newDecision.id);
        agents_notified = impact.affected_agents.map((a) => a.name);
      } catch {
        // best-effort
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                new_decision_id: result.newDecision.id,
                superseded_id: result.oldDecision.id,
                agents_notified,
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
