import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import type { Agent } from '@decigraph/sdk';
import { getClient, getProjectId, handleError, formatAgent } from '../cli-helpers.js';

export function registerAgentCommands(program: Command): void {
  const agents = program.command('agents').description('Manage agents');

  agents
    .command('list')
    .description('List agents for the current project')
    .action(async () => {
      const client = getClient();
      const projectId = getProjectId();
      const spinner = ora('Fetching agents...').start();

      try {
        const items = await client.listAgents(projectId);
        spinner.stop();

        if (items.length === 0) {
          console.warn(chalk.dim('\n  No agents found.'));
          return;
        }

        console.warn(chalk.bold(`\n  ${items.length} agent(s):`));
        items.forEach((a: Agent, i: number) => formatAgent(a, i));
        console.warn('');
      } catch (err) {
        handleError(err, spinner);
      }
    });

  agents
    .command('add <name> <role>')
    .description('Add a new agent to the project')
    .option('-b, --budget <tokens>', 'Context budget in tokens', '50000')
    .action(async (name: string, role: string, opts: { budget?: string }) => {
      const client = getClient();
      const projectId = getProjectId();
      const spinner = ora(`Creating agent ${chalk.bold(name)}...`).start();

      try {
        const agent = await client.createAgent(projectId, {
          name,
          role,
          context_budget_tokens: opts.budget ? parseInt(opts.budget, 10) : 50000,
        });
        spinner.succeed(chalk.green('Agent created!'));
        formatAgent(agent);
      } catch (err) {
        handleError(err, spinner);
      }
    });
}
