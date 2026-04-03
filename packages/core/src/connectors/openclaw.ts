import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import type { SourceConnector, ConversationChunk, WatchConfig } from './types.js';

/**
 * Tracks files already yielded in the current watch session.
 * Key: absolute file path; Value: last-seen mtime (ms).
 */
const seen = new Map<string, number>();

/**
 * Recursively finds all files matching the OpenClaw conversation pattern:
 *   {base}/workspace{name}/conversations/{files}
 */
async function findConversationFiles(basePath: string): Promise<string[]> {
  const results: string[] = [];

  let topEntries: Dirent[];
  try {
    topEntries = await fs.readdir(basePath, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of topEntries) {
    if (!entry.isDirectory() || !entry.name.startsWith('workspace')) continue;

    const workspacePath = path.join(basePath, entry.name, 'conversations');
    let convEntries: Dirent[];
    try {
      convEntries = await fs.readdir(workspacePath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const file of convEntries) {
      if (!file.isFile()) continue;
      results.push(path.join(workspacePath, file.name));
    }
  }

  return results;
}

/**
 * Derives the agent name from the directory path.
 * For a path like /base/workspaceMyAgent/conversations/file.txt
 * the agent name is "MyAgent".
 */
export function extractAgentName(filePath: string): string {
  const parts = filePath.split(path.sep);
  const workspaceIdx = parts.findIndex((p) => p.startsWith('workspace'));
  if (workspaceIdx === -1) return 'unknown';
  const segment = parts[workspaceIdx] ?? '';

  let agentName = segment.slice('workspace'.length).replace(/^[-_]/, '').trim();

  if (!agentName) {
    agentName = process.env.NEXUS_OPENCLAW_DEFAULT_AGENT || 'main';
  }

  return agentName;
}

async function readChunk(filePath: string): Promise<ConversationChunk | null> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return null;
  }

  const mtime = stat.mtime.getTime();
  const prev = seen.get(filePath);

  if (prev !== undefined && prev === mtime) {
    // File has not changed
    return null;
  }

  seen.set(filePath, mtime);

  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    console.error('[nexus:openclaw] Failed to read file:', filePath, err);
    return null;
  }

  if (!text.trim()) return null;

  const agentName = extractAgentName(filePath);
  const ext = path.extname(filePath).toLowerCase();

  return {
    text,
    source_id: filePath,
    agent_name: agentName,
    timestamp: stat.mtime,
    metadata: {
      file_path: filePath,
      file_name: path.basename(filePath),
      file_ext: ext,
      size_bytes: stat.size,
      mtime: stat.mtime.toISOString(),
    },
  };
}

export const openClawConnector: SourceConnector = {
  name: 'openclaw',
  type: 'directory',

  async *watch(config: WatchConfig): AsyncIterable<ConversationChunk> {
    const basePath = config.path;
    const intervalMs = config.poll_interval_ms ?? 30_000;

    console.warn(`[nexus:openclaw] Starting watch on ${basePath} (interval: ${intervalMs}ms)`);

    while (true) {
      const files = await findConversationFiles(basePath);

      for (const filePath of files) {
        const chunk = await readChunk(filePath);
        if (chunk) {
          yield chunk;
        }
      }

      await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    }
  },
};
