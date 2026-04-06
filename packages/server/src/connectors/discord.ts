/**
 * Discord Bot Decision Ingestion Connector.
 *
 * Listens in configured Discord channels for messages containing decision
 * language, then forwards them to the extraction queue.
 *
 * Commands: /decision, /ask, /status, /recent
 * Passive: monitors messages for decision patterns (50+ chars)
 * Thread support: reads thread messages as well
 */
import { submitForExtraction } from '../queue/index.js';
import { getDb } from '@decigraph/core/db/index.js';
import { callLLM } from '@decigraph/core/distillery/index.js';

// Types from discord.js — dynamically imported to avoid crashes when not installed
type Client = import('discord.js').Client;
type Message = import('discord.js').Message;
type Interaction = import('discord.js').ChatInputCommandInteraction;

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
let client: Client | null = null;
let _projectId = '';
let _allowedGuildIds: Set<string> = new Set();
let _allowedChannelIds: Set<string> = new Set();

// ── Public API ─────────────────────────────────────────────────────────────
export function isDiscordConnected(): boolean {
  return client !== null && client.isReady();
}

export function getDiscordStatus(): Record<string, unknown> {
  return {
    connected: isDiscordConnected(),
    guilds: client?.guilds?.cache?.size ?? 0,
  };
}

export async function startDiscordBot(): Promise<boolean> {
  const token = process.env.DECIGRAPH_DISCORD_BOT_TOKEN;
  if (!token) {
    console.warn('[decigraph/discord] No DECIGRAPH_DISCORD_BOT_TOKEN — Discord disabled');
    return false;
  }

  _projectId = process.env.DECIGRAPH_DISCORD_PROJECT_ID
    ?? process.env.DECIGRAPH_DEFAULT_PROJECT_ID
    ?? '';
  if (!_projectId) {
    console.error('[decigraph/discord] DECIGRAPH_DISCORD_PROJECT_ID required when Discord is enabled');
    return false;
  }

  // Parse guild/channel filters
  const guildIds = process.env.DECIGRAPH_DISCORD_GUILD_IDS ?? '';
  if (guildIds) {
    _allowedGuildIds = new Set(guildIds.split(',').map((s) => s.trim()).filter(Boolean));
  }
  const channelIds = process.env.DECIGRAPH_DISCORD_CHANNEL_IDS ?? '';
  if (channelIds) {
    _allowedChannelIds = new Set(channelIds.split(',').map((s) => s.trim()).filter(Boolean));
  }

  try {
    const { Client, GatewayIntentBits, Events } = await import('discord.js');

    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    client.once(Events.ClientReady, (readyClient) => {
      console.warn(`[decigraph/discord] Bot ready as ${readyClient.user.tag} (guilds: ${readyClient.guilds.cache.size})`);
    });

    client.on(Events.MessageCreate, async (message: Message) => {
      try {
        await handleMessage(message);
      } catch (err) {
        console.error('[decigraph/discord] Error handling message:', (err as Error).message);
      }
    });

    client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      try {
        await handleSlashCommand(interaction as Interaction);
      } catch (err) {
        console.error('[decigraph/discord] Error handling command:', (err as Error).message);
      }
    });

    await client.login(token);
    return true;
  } catch (err) {
    console.error('[decigraph/discord] Failed to start bot:', (err as Error).message);
    client = null;
    return false;
  }
}

export async function stopDiscordBot(): Promise<void> {
  if (client) {
    await client.destroy();
    client = null;
    console.warn('[decigraph/discord] Bot stopped');
  }
}

// ── Internal handlers ──────────────────────────────────────────────────────

function isAllowedChannel(message: Message): boolean {
  if (message.author.bot) return false;

  if (_allowedGuildIds.size > 0 && message.guildId) {
    if (!_allowedGuildIds.has(message.guildId)) return false;
  }

  if (_allowedChannelIds.size > 0) {
    // Check the channel ID and parent ID (for threads)
    const channelId = message.channelId;
    const parentId = ('parentId' in message.channel && message.channel.parentId)
      ? message.channel.parentId
      : null;
    if (!_allowedChannelIds.has(channelId) && (!parentId || !_allowedChannelIds.has(parentId))) {
      return false;
    }
  }

  return true;
}

async function handleMessage(message: Message): Promise<void> {
  const text = message.content;
  if (!text || text.length < 50) return;
  if (!isAllowedChannel(message)) return;

  // Check for decision-like commands as plain messages
  if (text.startsWith('!decision ')) {
    const decisionText = text.slice(10).trim();
    if (decisionText.length >= 10) {
      await submitForExtraction({
        raw_text: decisionText,
        source: 'telegram', // Maps to 'auto_distilled' in ingestion worker
        source_session_id: `discord:${message.guildId}:${message.channelId}:${message.id}`,
        made_by: message.author.username,
        project_id: _projectId,
      });
      try {
        await message.reply('Processing decision...');
      } catch { /* ignore */ }
      return;
    }
  }

  // Passive monitoring for decision patterns
  if (!matchesDecisionPattern(text)) return;

  await submitForExtraction({
    raw_text: text,
    source: 'telegram', // Maps to 'auto_distilled' in ingestion worker
    source_session_id: `discord:${message.guildId}:${message.channelId}:${message.id}`,
    made_by: message.author.username,
    project_id: _projectId,
  });
}

async function handleSlashCommand(interaction: Interaction): Promise<void> {
  const commandName = interaction.commandName;

  switch (commandName) {
    case 'decision': {
      const text = interaction.options.getString('text');
      if (!text || text.length < 10) {
        await interaction.reply({ content: 'Decision text must be at least 10 characters.', ephemeral: true });
        return;
      }

      await submitForExtraction({
        raw_text: text,
        source: 'telegram',
        source_session_id: `discord:${interaction.guildId}:${interaction.channelId}:${interaction.id}`,
        made_by: interaction.user.username,
        project_id: _projectId,
      });

      await interaction.reply('Processing decision...');
      break;
    }

    case 'ask': {
      const question = interaction.options.getString('question');
      if (!question) {
        await interaction.reply({ content: 'Please provide a question.', ephemeral: true });
        return;
      }

      await interaction.deferReply();

      try {
        const db = getDb();
        const result = await db.query(
          "SELECT title, description, made_by, tags FROM decisions WHERE project_id = ? AND status != 'superseded' ORDER BY created_at DESC LIMIT 20",
          [_projectId],
        );
        const decisions = result.rows as Array<Record<string, unknown>>;
        const decisionContext = decisions.map((d, i) =>
          `${i + 1}. "${d.title}" - ${d.description ?? ''} (by ${d.made_by ?? 'unknown'})`,
        ).join('\n');

        const answer = await callLLM(
          'You are a decision memory assistant. Answer the question using only the provided decisions. Be concise (2-4 sentences). No markdown.',
          `Question: ${question}\n\nDecisions:\n${decisionContext}`,
        );

        await interaction.editReply(answer || 'No relevant decisions found.');
      } catch (err) {
        console.error('[decigraph/discord] /ask error:', (err as Error).message);
        await interaction.editReply('Failed to process question.');
      }
      break;
    }

    case 'status': {
      try {
        const db = getDb();
        const [decResult, agentResult] = await Promise.all([
          db.query('SELECT count(*) as c FROM decisions WHERE project_id = ?', [_projectId]),
          db.query('SELECT count(*) as c FROM agents WHERE project_id = ?', [_projectId]),
        ]);
        const decCount = parseInt((decResult.rows[0] as Record<string, unknown>)?.c as string ?? '0', 10);
        const agentCount = parseInt((agentResult.rows[0] as Record<string, unknown>)?.c as string ?? '0', 10);

        await interaction.reply(`DeciGraph: ${decCount} decisions, ${agentCount} agents`);
      } catch (err) {
        console.error('[decigraph/discord] /status error:', (err as Error).message);
        await interaction.reply({ content: 'Failed to get status.', ephemeral: true });
      }
      break;
    }

    case 'recent': {
      try {
        const db = getDb();
        const result = await db.query(
          'SELECT title, made_by, created_at FROM decisions WHERE project_id = ? ORDER BY created_at DESC LIMIT 5',
          [_projectId],
        );
        const decisions = result.rows as Array<Record<string, unknown>>;

        if (decisions.length === 0) {
          await interaction.reply('No decisions recorded yet.');
          return;
        }

        const lines = decisions.map((d) => {
          const date = new Date(d.created_at as string).toLocaleDateString();
          return `- ${d.title} (${d.made_by}, ${date})`;
        });

        await interaction.reply(`**Recent decisions:**\n${lines.join('\n')}`);
      } catch (err) {
        console.error('[decigraph/discord] /recent error:', (err as Error).message);
        await interaction.reply({ content: 'Failed to get recent decisions.', ephemeral: true });
      }
      break;
    }

    default:
      await interaction.reply({ content: 'Unknown command.', ephemeral: true });
  }
}
