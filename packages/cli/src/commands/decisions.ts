import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import type { Decision } from '@decigraph/sdk';
import {
  getClient,
  getProjectId,
  handleError,
  prompt,
  promptMultiline,
  formatDecision,
  renderAsciiGraph,
} from '../cli-helpers.js';
import type { GraphResult } from '@decigraph/sdk';

export function registerDecisionCommands(program: Command): void {
  const decisions = program.command('decisions').description('Manage decisions');

  decisions
    .command('list')
    .description('List decisions for the current project')
    .option('-s, --status <status>', 'Filter by status (active|superseded|pending|reverted)')
    .option('-t, --tags <tags>', 'Filter by tags (comma-separated)')
    .option('-b, --by <agent>', 'Filter by made_by')
    .option('-l, --limit <n>', 'Max results', '20')
    .action(async (opts: { status?: string; tags?: string; by?: string; limit?: string }) => {
      const client = getClient();
      const projectId = getProjectId();
      const spinner = ora('Fetching decisions...').start();

      try {
        const items = await client.listDecisions(projectId, {
          status: opts.status as Decision['status'] | undefined,
          tags: opts.tags ? opts.tags.split(',').map((t) => t.trim()) : undefined,
          made_by: opts.by,
          limit: opts.limit ? parseInt(opts.limit, 10) : 20,
        });
        spinner.stop();

        if (items.length === 0) {
          console.warn(chalk.dim('\n  No decisions found.'));
          return;
        }

        console.warn(chalk.bold(`\n  ${items.length} decision(s):`));
        items.forEach((d, i) => formatDecision(d, i));
        console.warn('');
      } catch (err) {
        handleError(err, spinner);
      }
    });

  decisions
    .command('add')
    .description('Interactively add a new decision')
    .action(async () => {
      const client = getClient();
      const projectId = getProjectId();

      console.warn(chalk.bold('\nAdd a new decision\n'));

      const title = await prompt(chalk.bold('Title: '));
      if (!title) {
        console.error(chalk.red('Title is required'));
        process.exit(1);
      }

      const description = await promptMultiline(chalk.bold('Description:'));
      if (!description) {
        console.error(chalk.red('Description is required'));
        process.exit(1);
      }

      const reasoning = await promptMultiline(chalk.bold('Reasoning:'));
      if (!reasoning) {
        console.error(chalk.red('Reasoning is required'));
        process.exit(1);
      }

      const madeBy = await prompt(chalk.bold('Made by: '));
      if (!madeBy) {
        console.error(chalk.red('made_by is required'));
        process.exit(1);
      }

      const tagsInput = await prompt(chalk.dim('Tags (comma-separated, optional): '));
      const tags = tagsInput
        ? tagsInput
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
        : [];

      const affectsInput = await prompt(chalk.dim('Affects (comma-separated, optional): '));
      const affects = affectsInput
        ? affectsInput
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
        : [];

      const confidenceInput = await prompt(
        chalk.dim('Confidence [high/medium/low] (default: high): '),
      );
      const confidence = (
        ['high', 'medium', 'low'].includes(confidenceInput) ? confidenceInput : 'high'
      ) as 'high' | 'medium' | 'low';

      const spinner = ora('Creating decision...').start();
      try {
        const d = await client.createDecision(projectId, {
          title,
          description,
          reasoning,
          made_by: madeBy,
          tags,
          affects,
          confidence,
          status: 'active',
        });
        spinner.succeed(chalk.green('Decision created!'));
        formatDecision(d);
      } catch (err) {
        handleError(err, spinner);
      }
    });

  decisions
    .command('search <query>')
    .description('Semantic search across decisions')
    .option('-l, --limit <n>', 'Max results', '10')
    .action(async (query: string, opts: { limit?: string }) => {
      const client = getClient();
      const projectId = getProjectId();
      const spinner = ora('Searching...').start();

      try {
        const items = await client.searchDecisions(
          projectId,
          query,
          opts.limit ? parseInt(opts.limit, 10) : 10,
        );
        spinner.stop();

        if (items.length === 0) {
          console.warn(chalk.dim(`\n  No results for "${query}"`));
          return;
        }

        console.warn(chalk.bold(`\n  ${items.length} result(s) for "${chalk.cyan(query)}":`));
        items.forEach((d, i) => formatDecision(d, i));
        console.warn('');
      } catch (err) {
        handleError(err, spinner);
      }
    });

  decisions
    .command('graph <id>')
    .description('Show decision graph as ASCII tree')
    .option('-d, --depth <n>', 'Traversal depth', '3')
    .action(async (id: string, opts: { depth?: string }) => {
      const client = getClient();
      const spinner = ora('Loading graph...').start();

      try {
        const graph = await client.getGraph(id, opts.depth ? parseInt(opts.depth, 10) : 3);
        spinner.stop();
        renderAsciiGraph(graph as GraphResult);
      } catch (err) {
        handleError(err, spinner);
      }
    });

  decisions
    .command('impact <id>')
    .description('Show impact analysis for a decision')
    .action(async (id: string) => {
      const client = getClient();
      const spinner = ora('Analyzing impact...').start();

      try {
        const impact = await client.getImpact(id);
        spinner.stop();

        console.warn(`\n${chalk.bold('Impact Analysis')}`);
        formatDecision(impact.decision);

        if (impact.downstream_decisions.length) {
          console.warn(
            `\n${chalk.bold('Downstream Decisions:')} (${impact.downstream_decisions.length})`,
          );
          impact.downstream_decisions.forEach((d) => formatDecision(d));
        }

        if (impact.affected_agents.length) {
          console.warn(`\n${chalk.bold('Affected Agents:')} (${impact.affected_agents.length})`);
          for (const a of impact.affected_agents) {
            console.warn(`  ${chalk.cyan(a.id)} ${chalk.bold(a.name)} ${chalk.dim(`(${a.role})`)}`);
          }
        }

        if (impact.blocking_decisions.length) {
          console.warn(
            `\n${chalk.yellow('Blocking Decisions:')} (${impact.blocking_decisions.length})`,
          );
          impact.blocking_decisions.forEach((d) => formatDecision(d));
        }

        if (impact.supersession_chain.length) {
          console.warn(
            `\n${chalk.dim('Supersession Chain:')} (${impact.supersession_chain.length})`,
          );
          impact.supersession_chain.forEach((d) => formatDecision(d));
        }

        console.warn(
          `\n  ${chalk.dim('Cached contexts invalidated:')} ${impact.cached_contexts_invalidated}`,
        );
      } catch (err) {
        handleError(err, spinner);
      }
    });

  decisions
    .command('supersede <id>')
    .description('Supersede an existing decision with a new one')
    .action(async (id: string) => {
      const client = getClient();

      console.warn(chalk.bold(`\nSupersede decision ${chalk.cyan(id)}\n`));

      const title = await prompt(chalk.bold('New title: '));
      const description = await promptMultiline(chalk.bold('New description:'));
      const reasoning = await promptMultiline(chalk.bold('Reasoning for change:'));
      const madeBy = await prompt(chalk.bold('Made by: '));

      if (!title || !description || !reasoning || !madeBy) {
        console.error(chalk.red('All fields are required'));
        process.exit(1);
      }

      const spinner = ora('Superseding decision...').start();
      try {
        const result = await client.supersedeDecision(id, {
          title,
          description,
          reasoning,
          made_by: madeBy,
        });
        spinner.succeed(chalk.green('Decision superseded!'));
        console.warn(chalk.dim('\nNew decision:'));
        formatDecision(result.newDecision);
        console.warn(chalk.dim('\nOld decision (now superseded):'));
        formatDecision(result.oldDecision);
      } catch (err) {
        handleError(err, spinner);
      }
    });
}
