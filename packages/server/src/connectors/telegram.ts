/**
 * Telegram Bot Decision Ingestion Connector.
 *
 * Listens in configured Telegram channels for messages containing decision
 * language, then forwards them to the extraction queue.
 */
import TelegramBot from 'node-telegram-bot-api';
import { submitForExtraction } from '../queue/index.js';
import type { NotificationJobData } from '../queue/index.js';
import { getDb } from '@decigraph/core/db/index.js';
import { callLLM } from '@decigraph/core/distillery/index.js';

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

// ── State ──────────────────────────────────────────────────────────────────

let bot: TelegramBot | null = null;
let connectedChats = 0;
let _allowedChatIds: Set<string> = new Set();
let _projectId = '';
let _shouldReply = false;

// ── Public API ─────────────────────────────────────────────────────────────

export function isTelegramConnected(): boolean {
  return bot !== null;
}

export function getTelegramStatus(): Record<string, unknown> {
  return {
    connected: bot !== null,
    chats: connectedChats,
  };
}

/**
 * Handle a notification job — reply in Telegram with decision confirmation.
 */
export async function handleTelegramNotification(data: NotificationJobData): Promise<void> {
  if (!bot || !_shouldReply) return;
  if (data.source !== 'telegram' || !data.chat_id) return;

  try {
    const text = `✅ Decision captured: ${data.title}`;
    const opts: TelegramBot.SendMessageOptions = {};
    if (data.message_id) {
      opts.reply_to_message_id = data.message_id;
    }
    await bot.sendMessage(data.chat_id, text, opts);
  } catch (err) {
    console.warn('[decigraph/telegram] Failed to send reply:', (err as Error).message);
  }
}

/**
 * Start the Telegram bot listener.
 */
export function startTelegramBot(): boolean {
  const token = process.env.DECIGRAPH_TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn('[decigraph/telegram] No DECIGRAPH_TELEGRAM_BOT_TOKEN — Telegram disabled');
    return false;
  }

  _projectId = process.env.DECIGRAPH_TELEGRAM_PROJECT_ID ?? process.env.DECIGRAPH_DEFAULT_PROJECT_ID ?? '';
  if (!_projectId) {
    console.error('[decigraph/telegram] DECIGRAPH_TELEGRAM_PROJECT_ID required when Telegram is enabled');
    return false;
  }

  // Parse allowed chat IDs
  const chatIdsStr = process.env.DECIGRAPH_TELEGRAM_CHAT_IDS ?? '';
  if (chatIdsStr) {
    _allowedChatIds = new Set(chatIdsStr.split(',').map((s) => s.trim()).filter(Boolean));
  }

  _shouldReply = process.env.DECIGRAPH_INGEST_REPLY_ENABLED === 'true' || process.env.DECIGRAPH_TELEGRAM_REPLY === 'true';

  try {
    bot = new TelegramBot(token, { polling: true });
  } catch (err) {
    console.error('[decigraph/telegram] Failed to create bot:', (err as Error).message);
    return false;
  }

  bot.on('message', async (msg) => {
    try {
      await handleMessage(msg);
    } catch (err) {
      console.error('[decigraph/telegram] Error handling message:', (err as Error).message);
    }
  });

  // Handle /decision command
  bot.onText(/^\/decision\s+(.+)/s, async (msg, match) => {
    if (!match?.[1]) return;
    try {
      await handleDecisionCommand(msg, match[1]);
    } catch (err) {
      console.error('[decigraph/telegram] Error handling /decision command:', (err as Error).message);
    }
  });

  // Handle /ask command — Ask Anything (uses Opus)
  bot.onText(/^\/ask\s+(.+)/s, async (msg, match) => {
    if (!match?.[1]) return;
    const chatId = String(msg.chat.id);
    if (_allowedChatIds.size > 0 && !_allowedChatIds.has(chatId)) return;
    if (msg.from?.is_bot) return;

    try {
      const question = match[1].trim();
      await bot!.sendMessage(msg.chat.id, '🤔 Thinking...', { reply_to_message_id: msg.message_id });

      // Use Ask Anything — call LLM for synthesis
      const db = getDb();
      const result = await db.query(
        'SELECT title, description, made_by, tags FROM decisions WHERE project_id = ? AND status != ? ORDER BY created_at DESC LIMIT 20',
        [_projectId, 'superseded'],
      );
      const decisions = result.rows as Array<Record<string, unknown>>;
      const decisionContext = decisions.map((d, i) =>
        `${i + 1}. "${d.title}" — ${d.description ?? ''} (by ${d.made_by ?? 'unknown'})`
      ).join('\n');

      const answer = await callLLM(
        'You are a decision memory assistant. Answer the question using only the provided decisions. Be concise (2-4 sentences). No markdown.',
        `Question: ${question}\n\nDecisions:\n${decisionContext}`,
      );

      await bot!.sendMessage(msg.chat.id, answer || 'No relevant decisions found.', {
        reply_to_message_id: msg.message_id,
      });
    } catch (err) {
      console.error('[decigraph/telegram] /ask error:', (err as Error).message);
      try {
        await bot!.sendMessage(msg.chat.id, '❌ Failed to process question.', { reply_to_message_id: msg.message_id });
      } catch { /* ignore */ }
    }
  });

  // Handle /status command
  bot.onText(/^\/status$/, async (msg) => {
    const chatId = String(msg.chat.id);
    if (_allowedChatIds.size > 0 && !_allowedChatIds.has(chatId)) return;

    try {
      const db = getDb();
      const [decResult, agentResult] = await Promise.all([
        db.query('SELECT count(*) as c FROM decisions WHERE project_id = ?', [_projectId]),
        db.query('SELECT count(*) as c FROM agents WHERE project_id = ?', [_projectId]),
      ]);
      const decCount = parseInt((decResult.rows[0] as Record<string, unknown>)?.c as string ?? '0', 10);
      const agentCount = parseInt((agentResult.rows[0] as Record<string, unknown>)?.c as string ?? '0', 10);

      await bot!.sendMessage(msg.chat.id, `📊 DeciGraph: ${decCount} decisions, ${agentCount} agents, watcher active`);
    } catch (err) {
      console.error('[decigraph/telegram] /status error:', (err as Error).message);
    }
  });

  // Handle /recent command — show last 5 decisions
  bot.onText(/^\/recent$/, async (msg) => {
    const chatId = String(msg.chat.id);
    if (_allowedChatIds.size > 0 && !_allowedChatIds.has(chatId)) return;

    try {
      const db = getDb();
      const result = await db.query(
        'SELECT title, made_by, created_at FROM decisions WHERE project_id = ? ORDER BY created_at DESC LIMIT 5',
        [_projectId],
      );
      const decisions = result.rows as Array<Record<string, unknown>>;

      if (decisions.length === 0) {
        await bot!.sendMessage(msg.chat.id, 'No decisions recorded yet.');
        return;
      }

      const lines = decisions.map((d) => {
        const date = new Date(d.created_at as string).toLocaleDateString();
        return `• ${d.title} (${d.made_by}, ${date})`;
      });

      await bot!.sendMessage(msg.chat.id, `📋 Recent decisions:\n\n${lines.join('\n')}`);
    } catch (err) {
      console.error('[decigraph/telegram] /recent error:', (err as Error).message);
    }
  });

  // Handle /help command
  bot.onText(/^\/help$/, async (msg) => {
    const chatId = String(msg.chat.id);
    if (_allowedChatIds.size > 0 && !_allowedChatIds.has(chatId)) return;

    await bot!.sendMessage(msg.chat.id, [
      '📖 DeciGraph Bot Commands:',
      '',
      '/decision <text> — Record a decision',
      '/ask <question> — Ask about decisions',
      '/status — Show system info',
      '/recent — Show last 5 decisions',
      '/help — Show this message',
      '',
      'I also listen for decision language in regular messages (50+ chars).',
    ].join('\n'));
  });

  bot.on('polling_error', (err) => {
    console.error('[decigraph/telegram] Polling error:', err.message);
  });

  console.warn(`[decigraph/telegram] Bot started (chats: ${_allowedChatIds.size > 0 ? [..._allowedChatIds].join(', ') : 'all'}, reply: ${_shouldReply})`);
  return true;
}

/**
 * Stop the Telegram bot.
 */
export function stopTelegramBot(): void {
  if (bot) {
    bot.stopPolling();
    bot = null;
    console.warn('[decigraph/telegram] Bot stopped');
  }
}

// ── Internal handlers ──────────────────────────────────────────────────────

async function handleMessage(msg: TelegramBot.Message): Promise<void> {
  const text = msg.text;
  if (!text) return;

  const chatId = String(msg.chat.id);

  // Security: validate allowed chat IDs
  if (_allowedChatIds.size > 0 && !_allowedChatIds.has(chatId)) {
    return; // Silently ignore messages from unknown chats
  }

  // Ignore messages from the bot itself
  if (msg.from?.is_bot) return;

  // Ignore short messages
  if (text.length < 50) return;

  // Track connected chats
  connectedChats = Math.max(connectedChats, 1); // At least 1 if we're getting messages

  // Check if message matches decision patterns
  if (!matchesDecisionPattern(text)) return;

  // Extract agent name from username or first name
  const madeBy = msg.from?.username ?? msg.from?.first_name ?? 'unknown';

  await submitForExtraction({
    raw_text: text,
    source: 'telegram',
    source_session_id: `${chatId}:${msg.message_id}`,
    made_by: madeBy,
    project_id: _projectId,
  });
}

async function handleDecisionCommand(msg: TelegramBot.Message, decisionText: string): Promise<void> {
  const chatId = String(msg.chat.id);

  // Security: validate allowed chat IDs
  if (_allowedChatIds.size > 0 && !_allowedChatIds.has(chatId)) return;
  if (msg.from?.is_bot) return;
  if (decisionText.length < 10) return;

  const madeBy = msg.from?.username ?? msg.from?.first_name ?? 'unknown';

  await submitForExtraction({
    raw_text: decisionText,
    source: 'telegram',
    source_session_id: `${chatId}:${msg.message_id}`,
    made_by: madeBy,
    project_id: _projectId,
  });

  // Acknowledge the command immediately
  if (bot && _shouldReply) {
    try {
      await bot.sendMessage(msg.chat.id, '🔍 Processing decision...', {
        reply_to_message_id: msg.message_id,
      });
    } catch { /* ignore reply failure */ }
  }
}
