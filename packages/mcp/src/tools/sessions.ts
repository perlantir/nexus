import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DeciGraphClient } from '../../../sdk/src/index.js';
import type { DeciGraphServerConfig } from '../server.js';

export function registerSessionTools(
  server: McpServer,
  client: DeciGraphClient,
  config: DeciGraphServerConfig,
): void {
  server.registerTool(
    'decigraph_record_session',
    {
      title: 'Record a session summary',
      description:
        'Records a summary of a completed work session including decisions made, lessons learned, and open questions.',
      inputSchema: {
        agent_name: z.string().min(1).describe('Name of the agent that ran this session.'),
        topic: z.string().min(1).describe('Topic or goal of the session.'),
        summary: z.string().min(1).describe('Narrative summary of what happened in the session.'),
        decision_ids: z
          .array(z.string())
          .optional()
          .describe('IDs of decisions recorded during this session.'),
        lessons_learned: z
          .array(z.string())
          .optional()
          .describe('Insights and lessons from the session.'),
        assumptions: z
          .array(z.string())
          .optional()
          .describe('Assumptions made during the session.'),
        open_questions: z
          .array(z.string())
          .optional()
          .describe('Unresolved questions to be followed up on.'),
      },
    },
    async (args) => {
      const session = await client.createSession(config.projectId, {
        agent_name: args.agent_name,
        topic: args.topic,
        summary: args.summary,
        decision_ids: args.decision_ids,
        lessons_learned: args.lessons_learned,
        assumptions: args.assumptions,
        open_questions: args.open_questions,
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                session_id: session.id,
                agent_name: session.agent_name,
                topic: session.topic,
                session_date: session.session_date,
                decision_ids: session.decision_ids,
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
    'decigraph_get_notifications',
    {
      title: 'Get notifications',
      description:
        'Retrieves pending notifications for the current agent — such as decisions that have been superseded, reverted, or may affect ongoing work.',
      inputSchema: {
        unread_only: z
          .boolean()
          .optional()
          .describe('If true, return only unread notifications. Defaults to false.'),
      },
    },
    async (args) => {
      if (!config.agentId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                { error: 'No agent ID configured. Register an agent first.' },
                null,
                2,
              ),
            },
          ],
        };
      }

      const notifications = await client.getNotifications(
        config.agentId,
        args.unread_only ?? false,
      );

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(notifications, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    'decigraph_feedback',
    {
      title: 'Record relevance feedback',
      description:
        'Records whether a decision was useful in the current task. Used to improve future context compilation relevance scoring.',
      inputSchema: {
        decision_id: z.string().min(1).describe('The ID of the decision to give feedback on.'),
        was_useful: z.boolean().describe('Whether the decision was useful for the current task.'),
        usage_signal: z
          .enum(['referenced', 'ignored', 'contradicted', 'built_upon'])
          .describe('How the decision was used in practice.'),
      },
    },
    async (args) => {
      if (!config.agentId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                { error: 'No agent ID configured. Feedback requires an agent ID.' },
                null,
                2,
              ),
            },
          ],
        };
      }

      const feedback = await client.recordFeedback({
        agent_id: config.agentId,
        decision_id: args.decision_id,
        was_useful: args.was_useful,
        usage_signal: args.usage_signal,
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                feedback_id: feedback.id,
                decision_id: feedback.decision_id,
                was_useful: feedback.was_useful,
                usage_signal: feedback.usage_signal,
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
