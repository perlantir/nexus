/**
 * OpenClaw Session Auto-Discovery Connector.
 *
 * Watches the OpenClaw workspace directory for new/modified JSONL session files.
 * When an agent completes a task, extracts decisions from the session transcript.
 *
 * Directory layout: /data/.openclaw/workspace-<agentname>/session-*.jsonl
 */
import chokidar from 'chokidar';
import fs from 'node:fs';
import path from 'node:path';
import { submitForExtraction } from '../queue/index.js';

// Re-use the same decision patterns from telegram connector
const DECISION_PATTERNS: RegExp[] = [
  /\bdecision\s*:/i,
  /\bwe decided\b/i,
  /\bgoing with\b/i,
  /\bapproved\s*:/i,
  /\bchose\b.*\bover\b/i,
  /\bwill use\b.*\binstead\b/i,
  /\bfinal call\s*:/i,
  /\bagreed to\b/i,
  /\baction item\s*:/i,
  /\blet'?s go with\b/i,
  /\bconfirmed\s*:/i,
];

function matchesDecisionPattern(text: string): boolean {
  return DECISION_PATTERNS.some((p) => p.test(text));
}

// ── Types ──────────────────────────────────────────────────────────────────

interface CursorData {
  [filePath: string]: {
    offset: number;
    last_processed: string;
  };
}

interface JsonlMessage {
  role?: string;
  content?: string;
  type?: string;
  text?: string;
}

// ── State ──────────────────────────────────────────────────────────────────

let watcher: ReturnType<typeof chokidar.watch> | null = null;
let _watchPath = '';
let _projectId = '';
let _cursorPath = '';
let _cursors: CursorData = {};
let _filesTracked = 0;
let _decisionsCaptured = 0;

// ── Public API ─────────────────────────────────────────────────────────────

export function isOpenClawWatching(): boolean {
  return watcher !== null;
}

export function getOpenClawStatus(): Record<string, unknown> {
  return {
    watching: watcher !== null,
    path: _watchPath || null,
    files_tracked: _filesTracked,
    decisions_captured: _decisionsCaptured,
  };
}

/**
 * Start watching the OpenClaw workspace for JSONL session files.
 */
export function startOpenClawWatcher(): boolean {
  _watchPath = process.env.DECIGRAPH_OPENCLAW_PATH ?? process.env.DECIGRAPH_WATCH_DIR ?? '';
  if (!_watchPath) {
    console.warn('[decigraph/openclaw] No DECIGRAPH_OPENCLAW_PATH or DECIGRAPH_WATCH_DIR — watcher disabled');
    return false;
  }

  _projectId = process.env.DECIGRAPH_OPENCLAW_PROJECT_ID
    ?? process.env.DECIGRAPH_DEFAULT_PROJECT_ID
    ?? process.env.DECIGRAPH_TELEGRAM_PROJECT_ID
    ?? '';
  if (!_projectId) {
    console.error('[decigraph/openclaw] No project ID configured — watcher disabled');
    return false;
  }

  // Load cursor state
  _cursorPath = path.join(_watchPath, '.decigraph-cursor.json');
  loadCursors();

  // Watch for .jsonl and .md files
  const globPattern = path.join(_watchPath, '**', '*');

  try {
    watcher = chokidar.watch(globPattern, {
      persistent: true,
      ignoreInitial: false, // Process existing files on startup (from cursor)
      awaitWriteFinish: {
        stabilityThreshold: 2000,
        pollInterval: 500,
      },
      usePolling: true, // More reliable in Docker/NFS
      interval: 5000,
    });

    // Debug: log ALL chokidar events so we can see what it detects
    watcher.on('add', (filePath: string) => {
      console.log('[openclaw] chokidar event: add', filePath);
      if (filePath.endsWith('.jsonl') || filePath.endsWith('.md')) {
        void processFile(filePath);
      }
    });
    watcher.on('change', (filePath: string) => {
      console.log('[openclaw] chokidar event: change', filePath);
      if (filePath.endsWith('.jsonl') || filePath.endsWith('.md')) {
        void processFile(filePath);
      }
    });
    watcher.on('unlink', (filePath: string) => {
      console.log('[openclaw] chokidar event: unlink', filePath);
    });
    watcher.on('ready', () => {
      console.log('[openclaw] chokidar event: ready (initial scan complete)');
    });
    watcher.on('error', (err: unknown) => {
      console.log('[openclaw] chokidar event: error', (err as Error).message);
    });

    console.warn(`[decigraph/openclaw] Watching: ${_watchPath} (project: ${_projectId.slice(0, 8)}..)`);
    console.log(`[openclaw] glob pattern: ${globPattern}`);
    return true;
  } catch (err) {
    console.error('[decigraph/openclaw] Failed to start watcher:', (err as Error).message);
    return false;
  }
}

/**
 * Stop the file watcher.
 */
export async function stopOpenClawWatcher(): Promise<void> {
  if (watcher) {
    await watcher.close();
    watcher = null;
    saveCursors();
    console.warn('[decigraph/openclaw] Watcher stopped');
  }
}

// ── Internal ───────────────────────────────────────────────────────────────

/**
 * Extract agent name from directory path.
 * OpenClaw workspace: /data/.openclaw/workspace-<agentname>/session.jsonl
 */
function extractAgentName(filePath: string): string {
  const parts = filePath.split(path.sep);
  for (const part of parts) {
    const match = part.match(/^workspace-(.+)$/);
    if (match?.[1]) return match[1];
  }
  // Fallback: use parent directory name
  const parent = path.basename(path.dirname(filePath));
  return parent.replace(/^workspace-/, '') || 'unknown';
}

/**
 * Get the relative path key for cursor tracking.
 */
function cursorKey(filePath: string): string {
  return path.relative(_watchPath, filePath);
}

/**
 * Load cursor state from disk.
 */
function loadCursors(): void {
  try {
    if (fs.existsSync(_cursorPath)) {
      const raw = fs.readFileSync(_cursorPath, 'utf-8');
      _cursors = JSON.parse(raw) as CursorData;
      _filesTracked = Object.keys(_cursors).length;
    }
  } catch (err) {
    console.warn('[decigraph/openclaw] Failed to load cursors:', (err as Error).message);
    _cursors = {};
  }
}

/**
 * Save cursor state to disk.
 */
function saveCursors(): void {
  try {
    fs.writeFileSync(_cursorPath, JSON.stringify(_cursors, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[decigraph/openclaw] Failed to save cursors:', (err as Error).message);
  }
}

/**
 * Process a JSONL file — read from last cursor position, extract decisions.
 */
async function processFile(filePath: string): Promise<void> {
  const key = cursorKey(filePath);
  const cursor = _cursors[key];
  const startOffset = cursor?.offset ?? 0;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return; // File gone
  }

  // No new content since last cursor
  if (stat.size <= startOffset) return;

  // Read new content from cursor position
  let newContent: string;
  try {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(stat.size - startOffset);
    fs.readSync(fd, buffer, 0, buffer.length, startOffset);
    fs.closeSync(fd);
    newContent = buffer.toString('utf-8');
  } catch (err) {
    console.warn(`[decigraph/openclaw] Failed to read ${key}:`, (err as Error).message);
    return;
  }

  const agentName = extractAgentName(filePath);
  const lines = newContent.split('\n').filter((l) => l.trim());
  let decisionsFound = 0;
  const isMarkdown = filePath.endsWith('.md');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let textContent: string;

    if (isMarkdown) {
      // For .md files, each line is plain text
      textContent = line;
    } else {
      // For .jsonl files, parse JSON and only process assistant messages
      let msg: JsonlMessage;
      try {
        msg = JSON.parse(line) as JsonlMessage;
      } catch {
        continue; // Skip malformed lines
      }
      if (msg.role !== 'assistant') continue;
      textContent = msg.content ?? msg.text ?? '';
    }

    if (textContent.length < 50) continue;

    // Check for decision language
    if (!matchesDecisionPattern(textContent)) continue;

    const lineNumber = i + 1;

    await submitForExtraction({
      raw_text: textContent,
      source: 'openclaw',
      source_session_id: `${key}:${lineNumber}`,
      made_by: agentName,
      project_id: _projectId,
    });

    decisionsFound++;
  }

  // Update cursor
  _cursors[key] = {
    offset: stat.size,
    last_processed: new Date().toISOString(),
  };
  _filesTracked = Object.keys(_cursors).length;

  // Save cursors periodically (every file processed)
  saveCursors();

  if (decisionsFound > 0) {
    _decisionsCaptured += decisionsFound;
    console.log(`[decigraph/openclaw] ${key}: ${decisionsFound} potential decisions found (agent=${agentName})`);
  }
}
