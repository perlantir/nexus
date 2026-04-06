/**
 * OpenClaw Session Auto-Discovery Connector.
 *
 * Polls the OpenClaw workspace directory for new/modified session files
 * using fs.statSync mtime comparison. Pure Node stdlib (fs + path) — no
 * external file-watcher dependency. Works reliably inside Docker bind mounts.
 *
 * Token efficiency:
 *   - SKIP_FILES set filters out static config files (SOUL.md, etc.)
 *   - Only .jsonl files and session-named .md files are processed
 *   - Decision pattern pre-filter before any Distillery call
 *   - Content truncated to 2000 chars per extraction call
 *
 * Directory layout: /data/.openclaw/workspace-<agentname>/session-*.jsonl
 */
import fs from 'node:fs';
import path from 'node:path';
import { submitForExtraction } from '../queue/index.js';

// ── Config files to ALWAYS skip ────────────────────────────────────────────

const SKIP_FILES = new Set([
  'SOUL.md', 'AGENTS.md', 'HEARTBEAT.md', 'IDENTITY.md',
  'BOOTSTRAP.md', 'BOOT.md', 'TOOLS.md', 'USER.md',
  'QUALITY.md', 'HANDOFF.md', 'MEMORY.md', 'PERMISSION_MATRIX.md',
  'REPORT_TEMPLATE.md', 'SCORING_RUBRIC.md', 'REFERENCE_SECURITY_BASELINES.md',
  'TEST_DATA_AND_ROLES.md', 'ROUTE_AND_ENDPOINT_INVENTORY.md',
  'FALSE_POSITIVE_GUARDRAILS.md', 'LAUNCH_DECISION_RULES.md',
  'BENCHMARK_STANDARDS.md', 'AUDIT_DOMAINS.md', 'FLEET-MEMORY.md',
  'CEO-DIRECTIVE.md', 'RESTORE.md',
]);

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

// ── Constants ──────────────────────────────────────────────────────────────

const POLL_INTERVAL = 10_000; // 10 seconds
const MAX_EXTRACTION_LENGTH = 2000; // Max chars per Distillery call

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
let _filesSkipped = 0;
let _decisionsCaptured = 0;
let _polling = false; // Guard against overlapping polls

// ── Public API ─────────────────────────────────────────────────────────────

export function isOpenClawWatching(): boolean {
  return _pollTimer !== null;
}

export function getOpenClawStatus(): Record<string, unknown> {
  return {
    watching: _pollTimer !== null,
    path: _watchPath || null,
    files_tracked: _filesTracked,
    files_skipped: _filesSkipped,
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

  // Cursor stored in /tmp to avoid permission issues on mounted volumes
  _cursorPath = process.env.DECIGRAPH_CURSOR_PATH || '/tmp/.decigraph-cursor.json';
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

// ── File filtering ─────────────────────────────────────────────────────────

/**
 * Determine if a file should be processed.
 * Returns true for session files, false for config files.
 */
function shouldProcessFile(filePath: string): boolean {
  const basename = path.basename(filePath);

  // Always skip known config files
  if (SKIP_FILES.has(basename)) return false;

  // Always process .jsonl files (session transcripts)
  if (basename.endsWith('.jsonl')) return true;

  // Process .md files ONLY if they look like session files:
  //   - In a sessions/ subdirectory
  //   - Named session-* or conversation-*
  if (basename.endsWith('.md')) {
    const dir = path.basename(path.dirname(filePath));
    if (dir === 'sessions') return true;
    if (basename.startsWith('session-') || basename.startsWith('conversation-')) return true;

    // All other .md files in workspace root are config — skip them
    return false;
  }

  return false;
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
 * List all files in a directory and its immediate subdirectories.
 */
function listAllFiles(dirPath: string): string[] {
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isFile()) {
        results.push(fullPath);
      } else if (entry.isDirectory()) {
        // One level deep (e.g., sessions/ subdirectory)
        try {
          const subEntries = fs.readdirSync(fullPath);
          for (const sub of subEntries) {
            const subFull = path.join(fullPath, sub);
            try {
              if (fs.statSync(subFull).isFile()) results.push(subFull);
            } catch { /* skip */ }
          }
        } catch { /* skip unreadable subdirs */ }
      }
    }
  } catch { /* skip */ }
  return results;
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
    let skippedCount = 0;

    for (const dir of workspaceDirs) {
      const allFiles = listAllFiles(dir);

      for (const filePath of allFiles) {
        if (shouldProcessFile(filePath)) {
          trackedCount++;
          await checkAndProcessFile(filePath);
        } else {
          skippedCount++;
        }
      }
    }

    _filesTracked = trackedCount;
    _filesSkipped = skippedCount;
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

    // Pre-filter: MUST match decision pattern before calling Distillery.
    // This eliminates ~90% of false positives and saves $0.15-0.30 per call.
    if (!matchesDecisionPattern(textContent)) continue;

    // Truncate to max extraction length — most decisions are 1-2 sentences.
    const truncatedText = textContent.slice(0, MAX_EXTRACTION_LENGTH);
    const lineNumber = i + 1;

    await submitForExtraction({
      raw_text: truncatedText,
      source: 'openclaw',
      source_session_id: `${key}:${lineNumber}`,
      made_by: agentName,
      project_id: _projectId,
    });

    decisionsFound++;

    const snippet = truncatedText.slice(0, 80).replace(/\n/g, ' ');
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

function extractAgentName(filePath: string): string {
  const parts = filePath.split(path.sep);
  for (const part of parts) {
    const match = part.match(/^workspace-(.+)$/);
    if (match?.[1]) return match[1];
  }
  const parent = path.basename(path.dirname(filePath));
  return parent.replace(/^workspace-/, '') || 'unknown';
}

function loadCursors(): void {
  try {
    if (fs.existsSync(_cursorPath)) {
      const raw = fs.readFileSync(_cursorPath, 'utf-8');
      const data = JSON.parse(raw) as Record<string, CursorEntry>;
      for (const [key, entry] of Object.entries(data)) {
        _cursors.set(key, entry);
      }
      _filesTracked = _cursors.size;
      console.log(`[decigraph/openclaw] Loaded ${_cursors.size} cursors from ${_cursorPath}`);
    }
  } catch (err) {
    console.warn('[decigraph/openclaw] Failed to load cursors:', (err as Error).message);
  }
}

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
