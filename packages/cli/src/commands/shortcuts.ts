/**
 * Top-level shortcut commands for the DeciGraph CLI.
 *
 * decigraph add "title" --tags x,y --affects a,b
 * decigraph ask "question"
 * decigraph search --tags security --agent counsel
 * decigraph list --limit 20
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getClient, getProjectId, handleError } from '../cli-helpers.js';

export function registerShortcutCommands(program: Command): void {
  // ── add ─────────────────────────────────────────────────────────────────

  program
    .command('add <title>')
    .description('Record a new decision')
    .option('--tags <tags>', 'Comma-separated tags')
    .option('--affects <agents>', 'Comma-separated agent names')
    .option('--confidence <level>', 'high, medium, or low', 'high')
    .option('--description <desc>', 'Description of the decision')
    .option('--json', 'Output as JSON')
    .action(
      async (
        title: string,
        opts: {
          tags?: string;
          affects?: string;
          confidence?: string;
          description?: string;
          json?: boolean;
        },
      ) => {
        const client = getClient();
        const projectId = getProjectId();
        const spinner = ora('Recording decision...').start();

        try {
          const decision = await client.createDecision(projectId, {
            title,
            description: opts.description ?? '',
            reasoning: '',
            made_by: 'cli',
            source: 'manual',
            tags: opts.tags ? opts.tags.split(',').map((t) => t.trim()) : [],
            affects: opts.affects ? opts.affects.split(',').map((a) => a.trim()) : [],
            confidence: (opts.confidence as 'high' | 'medium' | 'low') ?? 'high',
          });
          spinner.stop();

          if (opts.json) {
            console.log(JSON.stringify(decision, null, 2));
          } else {
            console.log(`${chalk.green('✓')} Decision recorded: "${decision.title}" (id: ${decision.id})`);
          }
        } catch (err) {
          handleError(err, spinner);
        }
      },
    );

  // ── ask ─────────────────────────────────────────────────────────────────

  program
    .command('ask <question>')
    .description('Ask a natural language question about decisions')
    .option('--json', 'Output as JSON')
    .action(async (question: string, opts: { json?: boolean }) => {
      const client = getClient();
      const projectId = getProjectId();
      const spinner = ora('Thinking...').start();

      try {
        const result = await client.ask(projectId, question);
        spinner.stop();

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`\n${result.answer}\n`);
          if (result.sources?.length > 0) {
            console.log(chalk.dim('Sources:'));
            result.sources.forEach((s: { title: string; score: number }) => {
              console.log(chalk.dim(`  - ${s.title} (relevance: ${s.score})`));
            });
          }
        }
      } catch (err) {
        handleError(err, spinner);
      }
    });

  // ── search ──────────────────────────────────────────────────────────────

  program
    .command('search [query]')
    .description('Search decisions by text, tags, agent, or status')
    .option('--tags <tags>', 'Comma-separated tags to filter by')
    .option('--agent <name>', 'Filter by agent name')
    .option('--status <status>', 'Filter by status (active, superseded)')
    .option('--limit <n>', 'Max results', '10')
    .option('--json', 'Output as JSON')
    .action(
      async (
        query: string | undefined,
        opts: { tags?: string; agent?: string; status?: string; limit?: string; json?: boolean },
      ) => {
        const client = getClient();
        const projectId = getProjectId();
        const spinner = ora('Searching...').start();

        try {
          let decisions;
          const limit = parseInt(opts.limit ?? '10', 10);

          if (query) {
            decisions = await client.searchDecisions(projectId, query, limit);
          } else {
            decisions = await client.listDecisions(projectId, {
              status: opts.status as 'active' | 'superseded' | undefined,
              limit,
            });
          }

          // Client-side tag/agent filtering
          if (opts.tags) {
            const tagSet = new Set(opts.tags.split(',').map((t) => t.trim()));
            decisions = decisions.filter((d) =>
              (d.tags ?? []).some((t: string) => tagSet.has(t)),
            );
          }
          if (opts.agent) {
            decisions = decisions.filter(
              (d) => (d.affects ?? []).includes(opts.agent!) || d.made_by === opts.agent,
            );
          }

          spinner.stop();

          if (opts.json) {
            console.log(JSON.stringify(decisions, null, 2));
          } else if (decisions.length === 0) {
            console.log('No decisions found.');
          } else {
            console.log(`\nFound ${decisions.length} decisions:\n`);
            decisions.forEach((d) => {
              const tags = (d.tags ?? []).join(', ');
              console.log(`  ${chalk.bold(d.title)} ${chalk.dim(`[${d.status}]`)}`);
              console.log(`    ${chalk.dim(`by ${d.made_by}`)}${tags ? chalk.dim(` | tags: ${tags}`) : ''}`);
            });
          }
        } catch (err) {
          handleError(err, spinner);
        }
      },
    );

  // ── list ────────────────────────────────────────────────────────────────

  program
    .command('list')
    .description('List recent decisions')
    .option('--limit <n>', 'Max results', '20')
    .option('--source <source>', 'Filter by source (manual, auto_distilled)')
    .option('--json', 'Output as JSON')
    .action(async (opts: { limit?: string; source?: string; json?: boolean }) => {
      const client = getClient();
      const projectId = getProjectId();
      const spinner = ora('Loading decisions...').start();

      try {
        const decisions = await client.listDecisions(projectId, {
          limit: parseInt(opts.limit ?? '20', 10),
        });

        // Client-side source filtering
        const filtered = opts.source
          ? decisions.filter((d) => d.source === opts.source)
          : decisions;

        spinner.stop();

        if (opts.json) {
          console.log(JSON.stringify(filtered, null, 2));
        } else if (filtered.length === 0) {
          console.log('No decisions found.');
        } else {
          console.log(`\n${filtered.length} decisions:\n`);
          filtered.forEach((d) => {
            const date = new Date(d.created_at).toLocaleDateString();
            console.log(`  ${chalk.bold(d.title)} ${chalk.dim(`[${d.status}] ${date}`)}`);
            console.log(`    ${chalk.dim(`by ${d.made_by} | source: ${d.source}`)}`);
          });
        }
      } catch (err) {
        handleError(err, spinner);
      }
    });
}
