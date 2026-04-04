import chalk from 'chalk';
import ora from 'ora';
import { createInterface } from 'node:readline';
import { DeciGraphClient, DeciGraphApiError } from '@decigraph/sdk';
import type {
  Decision,
  Agent,
  Notification,
  ProjectStats,
  GraphResult,
  DecisionEdge,
} from '@decigraph/sdk';

export function getClient(): DeciGraphClient {
  const baseUrl = process.env.DECIGRAPH_API_URL ?? 'http://localhost:3000';
  const apiKey = process.env.DECIGRAPH_API_KEY;
  return new DeciGraphClient({ baseUrl, apiKey });
}

export function getProjectId(): string {
  const id = process.env.DECIGRAPH_PROJECT_ID;
  if (!id) {
    console.error(chalk.red('Error: DECIGRAPH_PROJECT_ID environment variable is not set.'));
    console.error(chalk.dim('Run `decigraph init` to create a project, then set DECIGRAPH_PROJECT_ID.'));
    process.exit(1);
  }
  return id;
}

export function handleError(err: unknown, spinner?: ReturnType<typeof ora>): never {
  if (spinner) spinner.fail();
  if (err instanceof DeciGraphApiError) {
    console.error(chalk.red(`API Error (${err.code}): ${err.message}`));
    if (err.details) {
      console.error(chalk.dim(JSON.stringify(err.details, null, 2)));
    }
  } else if (err instanceof Error) {
    console.error(chalk.red(`Error: ${err.message}`));
  } else {
    console.error(chalk.red('An unknown error occurred'));
  }
  process.exit(1);
}

export function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export function promptMultiline(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.warn(chalk.dim(question));
  console.warn(chalk.dim('(Enter an empty line to finish)'));

  return new Promise((resolve) => {
    const lines: string[] = [];
    rl.on('line', (line) => {
      if (line === '') {
        rl.close();
        resolve(lines.join('\n'));
      } else {
        lines.push(line);
      }
    });
  });
}

export function formatDecision(d: Decision, index?: number): void {
  const prefix = index !== undefined ? chalk.dim(`${index + 1}.`) + ' ' : '';
  const statusColor =
    {
      active: chalk.green,
      superseded: chalk.yellow,
      reverted: chalk.red,
      pending: chalk.blue,
    }[d.status] ?? chalk.white;

  const confidenceColor =
    {
      high: chalk.green,
      medium: chalk.yellow,
      low: chalk.red,
    }[d.confidence] ?? chalk.white;

  console.warn(`\n${prefix}${chalk.bold(d.title)}`);
  console.warn(`   ${chalk.dim('ID:')} ${chalk.cyan(d.id)}`);
  console.warn(
    `   ${chalk.dim('Status:')} ${statusColor(d.status)} | ${chalk.dim('Confidence:')} ${confidenceColor(d.confidence)} | ${chalk.dim('By:')} ${d.made_by}`,
  );
  console.warn(`   ${chalk.dim('Description:')} ${d.description}`);
  if (d.tags.length)
    console.warn(`   ${chalk.dim('Tags:')} ${d.tags.map((t) => chalk.magenta(`#${t}`)).join(' ')}`);
  if (d.affects.length) console.warn(`   ${chalk.dim('Affects:')} ${d.affects.join(', ')}`);
  console.warn(`   ${chalk.dim('Created:')} ${new Date(d.created_at).toLocaleString()}`);
}

export function formatAgent(a: Agent, index?: number): void {
  const prefix = index !== undefined ? chalk.dim(`${index + 1}.`) + ' ' : '';
  console.warn(`\n${prefix}${chalk.bold(a.name)} ${chalk.dim(`(${a.role})`)}`);
  console.warn(`   ${chalk.dim('ID:')} ${chalk.cyan(a.id)}`);
  console.warn(`   ${chalk.dim('Budget:')} ${a.context_budget_tokens.toLocaleString()} tokens`);
  console.warn(`   ${chalk.dim('Created:')} ${new Date(a.created_at).toLocaleString()}`);
}

export function formatNotification(n: Notification): void {
  const urgencyColor =
    {
      critical: chalk.bgRed.white,
      high: chalk.red,
      medium: chalk.yellow,
      low: chalk.dim,
    }[n.urgency] ?? chalk.white;

  const readStatus = n.read_at ? chalk.dim('[read]') : chalk.green('[unread]');
  console.warn(`\n  ${urgencyColor(`[${n.urgency.toUpperCase()}]`)} ${readStatus} ${n.message}`);
  console.warn(
    `    ${chalk.dim('ID:')} ${chalk.cyan(n.id)} | ${chalk.dim('Type:')} ${n.notification_type}`,
  );
  if (n.decision_id) console.warn(`    ${chalk.dim('Decision:')} ${n.decision_id}`);
  console.warn(`    ${chalk.dim('At:')} ${new Date(n.created_at).toLocaleString()}`);
}

export function formatStats(stats: ProjectStats): void {
  console.warn(`\n${chalk.bold.underline('Project Statistics')}`);
  console.warn(`  ${chalk.dim('Decisions:')}      ${chalk.bold(stats.total_decisions)}`);
  console.warn(`    ${chalk.green('Active:')}       ${stats.active_decisions}`);
  console.warn(`    ${chalk.yellow('Superseded:')}   ${stats.superseded_decisions}`);
  console.warn(`    ${chalk.blue('Pending:')}      ${stats.pending_decisions}`);
  console.warn(`  ${chalk.dim('Agents:')}         ${chalk.bold(stats.total_agents)}`);
  console.warn(`  ${chalk.dim('Artifacts:')}      ${chalk.bold(stats.total_artifacts)}`);
  console.warn(`  ${chalk.dim('Sessions:')}       ${chalk.bold(stats.total_sessions)}`);
  console.warn(`  ${chalk.dim('Edges:')}          ${chalk.bold(stats.total_edges)}`);
  console.warn(
    `  ${chalk.dim('Contradictions:')} ${stats.unresolved_contradictions > 0 ? chalk.red(stats.unresolved_contradictions) : chalk.green(stats.unresolved_contradictions)}`,
  );

  if (stats.recent_activity.length) {
    console.warn(`\n${chalk.bold('Recent Activity:')}`);
    for (const entry of stats.recent_activity.slice(0, 5)) {
      console.warn(
        `  ${chalk.dim(new Date(entry.created_at).toLocaleString())} ${chalk.cyan(entry.event_type)}`,
      );
    }
  }
}

export function renderAsciiGraph(graph: GraphResult): void {
  const { nodes, edges } = graph;

  if (nodes.length === 0) {
    console.warn(chalk.dim('  (no nodes in graph)'));
    return;
  }

  // Build adjacency map
  const adjMap = new Map<string, Array<{ targetId: string; rel: string; edge: DecisionEdge }>>();
  for (const node of nodes) {
    adjMap.set(node.id, []);
  }
  for (const edge of edges) {
    const list = adjMap.get(edge.source_id);
    if (list) {
      list.push({ targetId: edge.target_id, rel: edge.relationship, edge });
    }
  }

  // Find root nodes (no incoming edges)
  const hasIncoming = new Set(edges.map((e) => e.target_id));
  const roots = nodes.filter((n) => !hasIncoming.has(n.id));
  const startNodes = roots.length > 0 ? roots : nodes.slice(0, 1);

  const visited = new Set<string>();

  function renderNode(nodeId: string, indent: number, prefix: string): void {
    if (visited.has(nodeId)) {
      console.warn(
        `${'  '.repeat(indent)}${prefix}${chalk.dim(`[ref: ${nodeId.slice(0, 8)}...]`)}`,
      );
      return;
    }
    visited.add(nodeId);

    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return;

    const statusIndicator =
      {
        active: chalk.green('●'),
        superseded: chalk.yellow('◐'),
        reverted: chalk.red('○'),
        pending: chalk.blue('◌'),
      }[node.status] ?? '●';

    const confidenceIndicator =
      {
        high: chalk.green('★'),
        medium: chalk.yellow('☆'),
        low: chalk.red('☆'),
      }[node.confidence] ?? '';

    const titleDisplay = chalk.bold(
      node.title.length > 50 ? `${node.title.slice(0, 47)}...` : node.title,
    );
    console.warn(
      `${'  '.repeat(indent)}${prefix}${statusIndicator} ${titleDisplay} ${confidenceIndicator}`,
    );
    console.warn(
      `${'  '.repeat(indent)}   ${chalk.dim(node.id.slice(0, 8))} | ${chalk.dim(node.made_by)} | ${chalk.dim(node.status)}`,
    );

    const children = adjMap.get(nodeId) ?? [];
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (!child) continue;
      const isLast = i === children.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const relLabel = chalk.cyan(`[${child.rel}]`);
      console.warn(`${'  '.repeat(indent + 1)}${connector}${relLabel}`);
      renderNode(child.targetId, indent + 2, '');
    }
  }

  console.warn(`\n${chalk.bold('Decision Graph:')}`);
  console.warn(chalk.dim('  ● active  ◐ superseded  ○ reverted  ◌ pending\n'));

  for (const root of startNodes) {
    renderNode(root.id, 0, '');
    console.warn('');
  }

  // Render any unvisited nodes (disconnected subgraphs)
  for (const node of nodes) {
    if (!visited.has(node.id)) {
      renderNode(node.id, 0, '');
      console.warn('');
    }
  }
}
