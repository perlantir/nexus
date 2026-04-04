import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import type { Notification } from '@decigraph/sdk';
import { getClient, handleError, formatNotification } from '../cli-helpers.js';

export function registerNotificationCommands(program: Command): void {
  program
    .command('notifications')
    .description('Show unread notifications for an agent')
    .option('-a, --agent <id>', 'Agent ID')
    .option('--all', 'Show all notifications including read')
    .action(async (opts: { agent?: string; all?: boolean }) => {
      const client = getClient();
      const agentId = opts.agent ?? process.env.DECIGRAPH_AGENT_ID;

      if (!agentId) {
        console.error(
          chalk.red('Error: --agent <id> or DECIGRAPH_AGENT_ID environment variable is required'),
        );
        process.exit(1);
      }

      const spinner = ora('Fetching notifications...').start();

      try {
        const items = await client.getNotifications(agentId, !opts.all);
        spinner.stop();

        if (items.length === 0) {
          const label = opts.all ? 'notifications' : 'unread notifications';
          console.warn(chalk.dim(`\n  No ${label} found.`));
          return;
        }

        const unreadCount = items.filter((n: Notification) => !n.read_at).length;
        console.warn(chalk.bold(`\n  ${items.length} notification(s) (${unreadCount} unread):`));
        items.forEach(formatNotification);
        console.warn('');
      } catch (err) {
        handleError(err, spinner);
      }
    });

  program
    .command('feedback')
    .description('Record feedback on a decision')
    .requiredOption('-a, --agent <id>', 'Agent ID')
    .requiredOption('-d, --decision <id>', 'Decision ID')
    .requiredOption('--useful <bool>', 'Was the decision useful? (true|false)')
    .option('-s, --signal <signal>', 'Usage signal (referenced|ignored|contradicted|built_upon)')
    .action(async (opts: { agent: string; decision: string; useful: string; signal?: string }) => {
      const client = getClient();
      const spinner = ora('Recording feedback...').start();

      try {
        await client.recordFeedback({
          agent_id: opts.agent,
          decision_id: opts.decision,
          was_useful: opts.useful === 'true',
          usage_signal: opts.signal as
            | 'referenced'
            | 'ignored'
            | 'contradicted'
            | 'built_upon'
            | undefined,
        });
        spinner.succeed(chalk.green('Feedback recorded'));
      } catch (err) {
        handleError(err, spinner);
      }
    });

  program
    .command('contradictions')
    .description('Show unresolved contradictions for the project')
    .option(
      '-s, --status <status>',
      'Filter by status (unresolved|resolved|dismissed)',
      'unresolved',
    )
    .action(async (opts: { status?: string }) => {
      const client = getClient();
      const projectId = process.env.DECIGRAPH_PROJECT_ID;
      if (!projectId) {
        console.error(chalk.red('Error: DECIGRAPH_PROJECT_ID environment variable is not set.'));
        process.exit(1);
      }
      const spinner = ora('Fetching contradictions...').start();

      try {
        const items = await client.getContradictions(
          projectId,
          (opts.status ?? 'unresolved') as 'unresolved' | 'resolved' | 'dismissed',
        );
        spinner.stop();

        if (items.length === 0) {
          console.warn(chalk.green(`\n  No ${opts.status ?? 'unresolved'} contradictions found.`));
          return;
        }

        console.warn(chalk.bold(`\n  ${items.length} contradiction(s):`));
        for (const c of items) {
          console.warn(`\n  ${chalk.red('⚡')} ${chalk.bold(c.id)}`);
          console.warn(`    ${chalk.dim('Decision A:')} ${c.decision_a_id}`);
          console.warn(`    ${chalk.dim('Decision B:')} ${c.decision_b_id}`);
          console.warn(`    ${chalk.dim('Similarity:')} ${(c.similarity_score * 100).toFixed(1)}%`);
          if (c.conflict_description) {
            console.warn(`    ${chalk.dim('Description:')} ${c.conflict_description}`);
          }
          console.warn(`    ${chalk.dim('Status:')} ${c.status}`);
          console.warn(`    ${chalk.dim('Detected:')} ${new Date(c.detected_at).toLocaleString()}`);
        }
        console.warn('');
      } catch (err) {
        handleError(err, spinner);
      }
    });
}
