/**
 * OpenClaw Session Auto-Discovery Connector.
 *
 * Polls the OpenClaw workspace directory for new/modified .jsonl and .md
 * session files using fs.statSync mtime comparison. No inotify, no chokidar —
 * works reliably inside Docker bind mounts where host-side changes are
 * invisible to inotify/kqueue watchers.
 *
 * Directory layout: /data/.openclaw/workspace-<agentname>/session-*.jsonl
 */
import fs from 'node:fs';
import path from 'node:path';
import { submitForExtraction } from '../queue/index.js';

// ── Decision pattern matching ──────────────────────────────────────────────

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

interface CursorEntry {
  offset: number;
  mtime: number;
  last_processed: string;
}

interface JsonlMessage {
  role?: string;
  content?: string;
  type?: string;
  text?: string;
}

// ── State ──────────────────────────────────────────────────────────────────

let _pollTimer: ReturnType<typeof setInterval> | null = null;
let _watchPath = '';
let _projectId = '';
let _cursorPath = '';
const _cursors = new Map<string, CursorEntry>();
let _filesTracked = 0;
let _decisionsCaptured = 0;
let _polling = false; // Guard against overlapping polls

const POLL_INTERVAL = 10_000; // 10 seconds

// ── Public API ─────────────────────────────────────────────────────────────

export function isOpenClawWatching(): boolean {
  return _pollTimer !== null;
}

export function getOpenClawStatus(): Record<string, unknown> {
  return {
    watching: _pollTimer !== null,
    path: _watchPath || null,
    files_tracked: _filesTracked,
    decisions_captured: _decisionsCaptured,
  };
}

/**
 * Start polling the OpenClaw workspace for session files.
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

  // Verify directory exists
  if (!fs.existsSync(_watchPath)) {
    console.error(`[decigraph/openclaw] Watch path does not exist: ${_watchPath}`);
    return false;
  }

  // Load cursor state from disk
  _cursorPath = path.join(_watchPath, '.decigraph-cursor.json');
  loadCursors();

  // Count workspace dirs for startup log
  const workspaceDirs = listWorkspaceDirs();

  _pollTimer = setInterval(() => void pollOnce(), POLL_INTERVAL);

  // Run first poll immediately
  void pollOnce();

  console.warn(`[decigraph/openclaw] Polling: ${_watchPath} (${workspaceDirs.length} workspace dirs, interval: ${POLL_INTERVAL / 1000}s)`);
  return true;
}

/**
 * Stop the polling loop.
 */
export async function stopOpenClawWatcher(): Promise<void> {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
    saveCursors();
    console.warn('[decigraph/openclaw] Watcher stopped');
  }
}

// ── Polling loop ───────────────────────────────────────────────────────────

/**
 * List all workspace-* directories under the watch path.
 */
function listWorkspaceDirs(): string[] {
  try {
    const entries = fs.readdirSync(_watchPath, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && e.name.startsWith('workspace-'))
      .map((e) => path.join(_watchPath, e.name));
  } catch (err) {
    console.warn('[decigraph/openclaw] Failed to list workspace dirs:', (err as Error).message);
    return [];
  }
}

/**
 * List .jsonl and .md files in a directory (non-recursive, single level).
 */
function listSessionFiles(dirPath: string): string[] {
  try {
    const entries = fs.readdirSync(dirPath);
    return entries
      .filter((name) => name.endsWith('.jsonl') || name.endsWith('.md'))
      .map((name) => path.join(dirPath, name));
  } catch {
    return [];
  }
}

/**
 * Single poll iteration — scan all workspace dirs for new/modified files.
 */
async function pollOnce(): Promise<void> {
  if (_polling) return; // Skip if previous poll is still running
  _polling = true;

  try {
    const workspaceDirs = listWorkspaceDirs();
    let trackedCount = 0;

    for (const dir of workspaceDirs) {
      const files = listSessionFiles(dir);
      trackedCount += files.length;

      for (const filePath of files) {
        await checkAndProcessFile(filePath);
      }
    }

    _filesTracked = trackedCount;
  } catch (err) {
    console.error('[decigraph/openclaw] Poll error:', (err as Error).message);
  } finally {
    _polling = false;
  }
}

/**
 * Check a single file for new content by comparing mtime and offset.
 */
async function checkAndProcessFile(filePath: string): Promise<void> {
  const key = path.relative(_watchPath, filePath);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return; // File gone
  }

  const cursor = _cursors.get(key);
  const lastMtime = cursor?.mtime ?? 0;
  const lastOffset = cursor?.offset ?? 0;
  const currentMtime = stat.mtimeMs;

  // Skip if file hasn't been modified since last check
  if (currentMtime <= lastMtime && stat.size <= lastOffset) return;

  // Skip if no new bytes
  if (stat.size <= lastOffset) {
    // mtime changed but size didn't — update mtime cursor only
    _cursors.set(key, {
      offset: lastOffset,
      mtime: currentMtime,
      last_processed: new Date().toISOString(),
    });
    return;
  }

  // Read new content from last offset
  const newBytes = stat.size - lastOffset;
  let newContent: string;
  try {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(newBytes);
    fs.readSync(fd, buffer, 0, newBytes, lastOffset);
    fs.closeSync(fd);
    newContent = buffer.toString('utf-8');
  } catch (err) {
    console.warn(`[decigraph/openclaw] Failed to read ${key}:`, (err as Error).message);
    return;
  }

  console.log(`[decigraph/openclaw] New content in ${key} (${newBytes} bytes)`);

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

    // Log decision capture with title snippet
    const snippet = textContent.slice(0, 80).replace(/\n/g, ' ');
    console.log(`[decigraph/openclaw] Decision captured from ${agentName}: "${snippet}"`);
  }

  if (decisionsFound > 0) {
    _decisionsCaptured += decisionsFound;
  }

  // Update cursor
  _cursors.set(key, {
    offset: stat.size,
    mtime: currentMtime,
    last_processed: new Date().toISOString(),
  });

  // Flush cursors to disk after processing
  saveCursors();
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Extract agent name from directory path.
 * workspace-<agentname>/session.jsonl → agentname
 */
function extractAgentName(filePath: string): string {
  const parts = filePath.split(path.sep);
  for (const part of parts) {
    const match = part.match(/^workspace-(.+)$/);
    if (match?.[1]) return match[1];
  }
  const parent = path.basename(path.dirname(filePath));
  return parent.replace(/^workspace-/, '') || 'unknown';
}

/**
 * Load cursor state from disk into the in-memory Map.
 */
function loadCursors(): void {
  try {
    if (fs.existsSync(_cursorPath)) {
      const raw = fs.readFileSync(_cursorPath, 'utf-8');
      const data = JSON.parse(raw) as Record<string, CursorEntry>;
      for (const [key, entry] of Object.entries(data)) {
        _cursors.set(key, entry);
      }
      _filesTracked = _cursors.size;
    }
  } catch (err) {
    console.warn('[decigraph/openclaw] Failed to load cursors:', (err as Error).message);
  }
}

/**
 * Flush in-memory cursor Map to disk.
 */
function saveCursors(): void {
  try {
    const obj: Record<string, CursorEntry> = {};
    for (const [key, entry] of _cursors.entries()) {
      obj[key] = entry;
    }
    fs.writeFileSync(_cursorPath, JSON.stringify(obj, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[decigraph/openclaw] Failed to save cursors:', (err as Error).message);
  }
}
