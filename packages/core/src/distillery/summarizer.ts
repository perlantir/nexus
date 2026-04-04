import crypto from 'node:crypto';
import type { Decision, SessionSummary } from '../types.js';
import { getDb } from '../db/index.js';
import { parseSession } from '../db/parsers.js';
import { generateEmbedding } from '../decision-graph/embeddings.js';
import {
  callLLM,
  parseJsonSafe,
  scrubSecrets,
  INJECTION_GUARD,
  getModelIdentifier,
} from './extractor.js';

const SESSION_SUMMARY_SYSTEM_PROMPT = `You are summarising a software development session between a developer and an AI agent.

Given the conversation transcript and the list of decisions made, produce a structured JSON summary:
{
  "summary": "2-4 sentence overview of what was accomplished",
  "assumptions": ["List of key assumptions made during the session"],
  "open_questions": ["Unresolved questions that need follow-up"],
  "lessons_learned": ["Insights or patterns worth remembering for future sessions"]
}

Be concise and technical. Focus on information useful to engineers who will work on this project later.`;

interface LLMSessionSummary {
  summary: string;
  assumptions: string[];
  open_questions: string[];
  lessons_learned: string[];
}

/** Stage 5 — Generate a session summary and persist it to the DB. */
export async function createSessionSummary(
  projectId: string,
  agentName: string,
  topic: string,
  conversationText: string,
  decisions: Decision[],
): Promise<SessionSummary> {
  const decisionList = decisions.map((d, i) => `${i + 1}. ${d.title}: ${d.description}`).join('\n');

  const safeText = scrubSecrets(conversationText);

  const userMessage =
    `Conversation:\n${safeText}\n\n` +
    `Decisions made in this session:\n${decisionList || '(none)'}`;

  let summaryData: LLMSessionSummary = {
    summary: `Session covering: ${topic}`,
    assumptions: [],
    open_questions: [],
    lessons_learned: [],
  };

  try {
    const rawResponse = await callLLM(SESSION_SUMMARY_SYSTEM_PROMPT, INJECTION_GUARD + userMessage);
    const parsed = parseJsonSafe<LLMSessionSummary>(rawResponse);

    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      typeof (parsed as LLMSessionSummary).summary === 'string'
    ) {
      const p = parsed as LLMSessionSummary;
      summaryData = {
        summary: p.summary || summaryData.summary,
        assumptions: Array.isArray(p.assumptions) ? p.assumptions.map(String) : [],
        open_questions: Array.isArray(p.open_questions) ? p.open_questions.map(String) : [],
        lessons_learned: Array.isArray(p.lessons_learned) ? p.lessons_learned.map(String) : [],
      };
    }
  } catch (err) {
    console.error('[decigraph:distillery] createSessionSummary LLM call failed');
    // Continue with default summary
  }

  const rawHash = crypto.createHash('sha256').update(conversationText).digest('hex');
  const decisionIds = decisions.map((d) => d.id);

  const summaryEmbedding = await generateEmbedding(`${topic}\n${summaryData.summary}`).catch(
    (err: unknown) => {
      console.warn('[decigraph:distillery] Session summary embedding failed:', err);
      return null;
    },
  );

  const vectorLiteral =
    summaryEmbedding && !summaryEmbedding.every((v) => v === 0)
      ? `[${summaryEmbedding.join(',')}]`
      : null;

  const allOpenQuestions = [
    ...summaryData.open_questions,
    ...decisions.flatMap((d) => d.open_questions),
  ];
  const uniqueOpenQuestions = [...new Set(allOpenQuestions)];

  const allAssumptions = [...summaryData.assumptions, ...decisions.flatMap((d) => d.assumptions)];
  const uniqueAssumptions = [...new Set(allAssumptions)];

  const model = getModelIdentifier();

  try {
    const db = getDb();
    const insertResult = await db.query<Record<string, unknown>>(
      `INSERT INTO session_summaries
         (project_id, agent_name, session_date, topic, summary,
          decision_ids, artifact_ids, assumptions, open_questions,
          lessons_learned, raw_conversation_hash, extraction_model,
          extraction_confidence, embedding)
       VALUES
         (?, ?, CURRENT_DATE, ?, ?,
          ?, '{}', ?, ?,
          ?, ?, ?,
          ?, ?)
       RETURNING *`,
      [
        projectId,
        agentName,
        topic,
        summaryData.summary,
        db.arrayParam(decisionIds),
        db.arrayParam(uniqueAssumptions),
        db.arrayParam(uniqueOpenQuestions),
        db.arrayParam(summaryData.lessons_learned),
        rawHash,
        model,
        decisions.length > 0 ? 0.8 : 0.5,
        vectorLiteral,
      ],
    );

    const row = insertResult.rows[0];
    if (!row) throw new Error('session_summaries insert returned no rows');
    return parseSession(row);
  } catch (err) {
    console.error('[decigraph:distillery] createSessionSummary DB insert failed:', err);
    throw err;
  }
}
