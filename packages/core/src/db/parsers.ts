import type {
  Decision,
  Agent,
  Project,
  Artifact,
  SessionSummary,
  Subscription,
  Notification,
  DecisionEdge,
  Contradiction,
  RelevanceFeedback,
  AuditEntry,
  ApiKey,
  RelevanceProfile,
} from '../types.js';

/**
 * Parse a pgvector embedding into number[].
 * pgvector can return: string "[0.02,0.08,...]", actual number[], or undefined.
 */
function parseEmbedding(raw: unknown): number[] | undefined {
  if (!raw) return undefined;
  if (Array.isArray(raw)) {
    return raw.length > 0 && typeof raw[0] === 'number' ? raw as number[] : undefined;
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'number') {
        return parsed as number[];
      }
    } catch { /* not valid JSON */ }
  }
  return undefined;
}

function parseJsonb<T>(val: unknown, fallback: T): T {
  if (val === null || val === undefined) return fallback;
  if (typeof val === 'string') {
    try {
      return JSON.parse(val) as T;
    } catch {
      return fallback;
    }
  }
  return val as T;
}

function parseArray(val: unknown): string[] {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string' && val.startsWith('{')) {
    return val.slice(1, -1).split(',').filter(Boolean);
  }
  return [];
}

export function parseProject(row: Record<string, unknown>): Project {
  return {
    id: row.id as string,
    name: row.name as string,
    description: row.description as string | undefined,
    created_at: (row.created_at as Date).toISOString(),
    updated_at: (row.updated_at as Date).toISOString(),
    metadata: parseJsonb(row.metadata, {}),
  };
}

export function parseAgent(row: Record<string, unknown>): Agent {
  return {
    id: row.id as string,
    project_id: row.project_id as string,
    name: row.name as string,
    role: row.role as string,
    relevance_profile: parseJsonb<RelevanceProfile>(row.relevance_profile, {
      weights: {},
      decision_depth: 2,
      freshness_preference: 'balanced',
      include_superseded: false,
    }),
    context_budget_tokens: row.context_budget_tokens as number,
    created_at: (row.created_at as Date).toISOString(),
    updated_at: (row.updated_at as Date).toISOString(),
  };
}

export function parseDecision(row: Record<string, unknown>): Decision {
  return {
    id: row.id as string,
    project_id: row.project_id as string,
    title: row.title as string,
    description: row.description as string,
    reasoning: row.reasoning as string,
    made_by: row.made_by as string,
    source: row.source as Decision['source'],
    source_session_id: row.source_session_id as string | undefined,
    confidence: row.confidence as Decision['confidence'],
    status: row.status as Decision['status'],
    supersedes_id: row.supersedes_id as string | undefined,
    alternatives_considered: parseJsonb(row.alternatives_considered, []),
    affects: parseArray(row.affects),
    tags: parseArray(row.tags),
    assumptions: parseJsonb(row.assumptions, []),
    open_questions: parseJsonb(row.open_questions, []),
    dependencies: parseJsonb(row.dependencies, []),
    validated_at: row.validated_at ? (row.validated_at as Date).toISOString() : undefined,
    validation_source: row.validation_source as string | undefined,
    confidence_decay_rate: (row.confidence_decay_rate as number) ?? 0,
    created_at: (row.created_at as Date).toISOString(),
    updated_at: (row.updated_at as Date).toISOString(),
    metadata: parseJsonb(row.metadata, {}),
    embedding: parseEmbedding(row.embedding),
  };
}

export function parseEdge(row: Record<string, unknown>): DecisionEdge {
  return {
    id: row.id as string,
    source_id: row.source_id as string,
    target_id: row.target_id as string,
    relationship: row.relationship as DecisionEdge['relationship'],
    description: row.description as string | undefined,
    strength: (row.strength as number) ?? 1.0,
    created_at: (row.created_at as Date).toISOString(),
  };
}

export function parseArtifact(row: Record<string, unknown>): Artifact {
  return {
    id: row.id as string,
    project_id: row.project_id as string,
    name: row.name as string,
    path: row.path as string | undefined,
    artifact_type: row.artifact_type as Artifact['artifact_type'],
    description: row.description as string | undefined,
    content_summary: row.content_summary as string | undefined,
    content_hash: row.content_hash as string | undefined,
    produced_by: row.produced_by as string,
    related_decision_ids: parseArray(row.related_decision_ids),
    created_at: (row.created_at as Date).toISOString(),
    updated_at: (row.updated_at as Date).toISOString(),
    metadata: parseJsonb(row.metadata, {}),
    embedding: parseEmbedding(row.embedding),
  };
}

export function parseSession(row: Record<string, unknown>): SessionSummary {
  return {
    id: row.id as string,
    project_id: row.project_id as string,
    agent_name: row.agent_name as string,
    session_date: String(row.session_date),
    topic: row.topic as string,
    summary: row.summary as string,
    decision_ids: parseArray(row.decision_ids),
    artifact_ids: parseArray(row.artifact_ids),
    assumptions: parseArray(row.assumptions),
    open_questions: parseArray(row.open_questions),
    lessons_learned: parseArray(row.lessons_learned),
    raw_conversation_hash: row.raw_conversation_hash as string | undefined,
    extraction_model: row.extraction_model as string | undefined,
    extraction_confidence: row.extraction_confidence as number | undefined,
    created_at: (row.created_at as Date).toISOString(),
    embedding: parseEmbedding(row.embedding),
  };
}

export function parseSubscription(row: Record<string, unknown>): Subscription {
  return {
    id: row.id as string,
    agent_id: row.agent_id as string,
    topic: row.topic as string,
    notify_on: parseArray(row.notify_on) as Subscription['notify_on'],
    priority: row.priority as Subscription['priority'],
    created_at: (row.created_at as Date).toISOString(),
  };
}

export function parseNotification(row: Record<string, unknown>): Notification {
  return {
    id: row.id as string,
    agent_id: row.agent_id as string,
    decision_id: row.decision_id as string | undefined,
    notification_type: row.notification_type as Notification['notification_type'],
    message: row.message as string,
    role_context: row.role_context as string | undefined,
    urgency: row.urgency as Notification['urgency'],
    read_at: row.read_at ? (row.read_at as Date).toISOString() : undefined,
    created_at: (row.created_at as Date).toISOString(),
  };
}

export function parseContradiction(row: Record<string, unknown>): Contradiction {
  return {
    id: row.id as string,
    project_id: row.project_id as string,
    decision_a_id: row.decision_a_id as string,
    decision_b_id: row.decision_b_id as string,
    similarity_score: row.similarity_score as number,
    conflict_description: row.conflict_description as string | undefined,
    status: row.status as Contradiction['status'],
    resolved_by: row.resolved_by as string | undefined,
    resolution: row.resolution as string | undefined,
    detected_at: (row.detected_at as Date).toISOString(),
    resolved_at: row.resolved_at ? (row.resolved_at as Date).toISOString() : undefined,
  };
}

export function parseFeedback(row: Record<string, unknown>): RelevanceFeedback {
  return {
    id: row.id as string,
    agent_id: row.agent_id as string,
    decision_id: row.decision_id as string,
    compile_request_id: row.compile_request_id as string | undefined,
    was_useful: row.was_useful as boolean,
    usage_signal: row.usage_signal as RelevanceFeedback['usage_signal'],
    created_at: (row.created_at as Date).toISOString(),
  };
}

export function parseAuditEntry(row: Record<string, unknown>): AuditEntry {
  return {
    id: row.id as string,
    event_type: row.event_type as string,
    agent_id: row.agent_id as string | undefined,
    project_id: row.project_id as string | undefined,
    decision_id: row.decision_id as string | undefined,
    details: parseJsonb(row.details, {}),
    created_at: (row.created_at as Date).toISOString(),
  };
}

export function parseApiKey(row: Record<string, unknown>): ApiKey {
  return {
    id: row.id as string,
    key_hash: row.key_hash as string,
    project_id: row.project_id as string,
    name: row.name as string,
    scopes: parseArray(row.scopes),
    last_used_at: row.last_used_at ? (row.last_used_at as Date).toISOString() : undefined,
    created_at: (row.created_at as Date).toISOString(),
    revoked_at: row.revoked_at ? (row.revoked_at as Date).toISOString() : undefined,
  };
}
