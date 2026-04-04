import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getClient, getProjectId, handleError } from '../cli-helpers.js';

export function registerExportImportCommands(program: Command): void {
  // ── decigraph export ──────────────────────────────────────────────────────
  program
    .command('export')
    .description('Export a project as JSON (writes to stdout)')
    .option('-p, --project <id>', 'Project ID (defaults to DECIGRAPH_PROJECT_ID)')
    .action(async (opts: { project?: string }) => {
      const client = getClient();
      const projectId = opts.project ?? getProjectId();
      const spinner = ora('Exporting project...').start();

      try {
        const baseUrl = process.env.DECIGRAPH_API_URL ?? 'http://localhost:3000';
        const apiKey = process.env.DECIGRAPH_API_KEY;
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

        const res = await fetch(`${baseUrl}/api/projects/${projectId}/export`, { headers });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Export failed (${res.status}): ${text}`);
        }

        const data = await res.json();
        spinner.stop();

        // Write JSON to stdout (not stderr) so it can be piped to file
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');

        console.error(
          chalk.green(`\nExported: ${(data as Record<string, unknown[]>).decisions?.length ?? 0} decisions, ${(data as Record<string, unknown[]>).agents?.length ?? 0} agents`),
        );
      } catch (err) {
        handleError(err, spinner);
      }
    });

  // ── decigraph import ──────────────────────────────────────────────────────
  program
    .command('import [file]')
    .description('Import a project from a JSON export file (or stdin)')
    .action(async (file?: string) => {
      const spinner = ora('Importing project...').start();

      try {
        let jsonText: string;

        if (file) {
          const filePath = resolve(file);
          if (!existsSync(filePath)) {
            spinner.fail();
            console.error(chalk.red(`File not found: ${filePath}`));
            process.exit(1);
          }
          jsonText = readFileSync(filePath, 'utf-8');
        } else {
          // Read from stdin
          const chunks: Buffer[] = [];
          for await (const chunk of process.stdin) {
            chunks.push(chunk as Buffer);
          }
          jsonText = Buffer.concat(chunks).toString('utf-8');
        }

        if (!jsonText.trim()) {
          spinner.fail();
          console.error(chalk.red('Empty input'));
          process.exit(1);
        }

        let data: unknown;
        try {
          data = JSON.parse(jsonText);
        } catch {
          spinner.fail();
          console.error(chalk.red('Invalid JSON'));
          process.exit(1);
        }

        const baseUrl = process.env.DECIGRAPH_API_URL ?? 'http://localhost:3000';
        const apiKey = process.env.DECIGRAPH_API_KEY;
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

        const res = await fetch(`${baseUrl}/api/projects/import`, {
          method: 'POST',
          headers,
          body: JSON.stringify(data),
        });

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Import failed (${res.status}): ${text}`);
        }

        const result = (await res.json()) as {
          project_id: string;
          project_name: string;
          agents_imported: number;
          decisions_imported: number;
          edges_imported: number;
          contradictions_imported: number;
          warnings: string[];
        };

        spinner.succeed(chalk.green(`Imported as "${result.project_name}"`));
        console.error(`  Project ID: ${chalk.cyan(result.project_id)}`);
        console.error(`  Agents:     ${result.agents_imported}`);
        console.error(`  Decisions:  ${result.decisions_imported}`);
        console.error(`  Edges:      ${result.edges_imported}`);
        console.error(`  Conflicts:  ${result.contradictions_imported}`);

        if (result.warnings.length > 0) {
          console.error(chalk.yellow(`\n  Warnings:`));
          for (const w of result.warnings) {
            console.error(chalk.yellow(`    - ${w}`));
          }
        }
      } catch (err) {
        handleError(err, spinner);
      }
    });
}
