import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import type { SourceConnector, ConversationChunk, WatchConfig } from './types.js';

/** Supported file extensions for generic directory watching. */
const SUPPORTED_EXTENSIONS = new Set(['.txt', '.md', '.json', '.log']);

/**
 * Tracks files already yielded in the current watch session.
 * Key: absolute file path; Value: last-seen mtime (ms).
 */
const seen = new Map<string, number>();

/**
 * Returns true if the filename matches the given glob-style pattern.
 * Supports simple wildcards: * (any chars except sep), ** (any chars).
 */
function matchPattern(filename: string, pattern: string): boolean {
  // Convert glob to regex: escape dots, replace * with [^/]*, ** with .*
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\x00') // placeholder for **
    .replace(/\*/g, '[^/]*')
    .replace(/\x00/g, '.*');
  const regex = new RegExp(`^${escaped}$`, 'i');
  return regex.test(filename);
}

async function collectFiles(dirPath: string, pattern?: string): Promise<string[]> {
  const results: string[] = [];

  let entries: Dirent[];
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;

    const ext = path.extname(entry.name).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) continue;

    if (pattern && !matchPattern(entry.name, pattern)) continue;

    results.push(path.join(dirPath, entry.name));
  }

  return results;
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
    return null;
  }

  seen.set(filePath, mtime);

  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    console.error('[decigraph:directory] Failed to read file:', filePath, err);
    return null;
  }

  if (!text.trim()) return null;

  const ext = path.extname(filePath).toLowerCase();

  return {
    text,
    source_id: filePath,
    timestamp: stat.mtime,
    metadata: {
      file_path: filePath,
      file_name: path.basename(filePath),
      file_ext: ext,
      size_bytes: stat.size,
      mtime: stat.mtime.toISOString(),
      directory: path.dirname(filePath),
    },
  };
}

export const directoryConnector: SourceConnector = {
  name: 'directory',
  type: 'directory',

  async *watch(config: WatchConfig): AsyncIterable<ConversationChunk> {
    const dirPath = config.path;
    const pattern = config.pattern ?? process.env['DECIGRAPH_WATCH_PATTERN'];
    const intervalMs = config.poll_interval_ms ?? 30_000;

    console.warn(
      `[decigraph:directory] Starting watch on ${dirPath}` +
        (pattern ? ` (pattern: ${pattern})` : '') +
        ` (interval: ${intervalMs}ms)`,
    );

    while (true) {
      const files = await collectFiles(dirPath, pattern);

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
