// --- Projects ---
export interface Project {
  id: string;
  name: string;
  description?: string;
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown>;
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

// --- Agents ---
export interface Agent {
  id: string;
  project_id: string;
  name: string;
  role: string;
  relevance_profile: RelevanceProfile;
  context_budget_tokens: number;
  created_at: string;
  updated_at: string;
}

export interface CreateAgentInput {
  project_id: string;
  name: string;
  role: string;
  relevance_profile?: RelevanceProfile;
  context_budget_tokens?: number;
}

export interface RelevanceProfile {
  weights: Record<string, number>;
  decision_depth: number;
  freshness_preference: FreshnessPreference;
  include_superseded: boolean;
}

export type FreshnessPreference = 'recent_first' | 'validated_first' | 'balanced';

// --- Decisions ---
export interface Decision {
  id: string;
  project_id: string;
  title: string;
  description: string;
  reasoning: string;
  made_by: string;
  source: DecisionSource;
  source_session_id?: string;
  confidence: ConfidenceLevel;
  status: DecisionStatus;
  supersedes_id?: string;
  alternatives_considered: Alternative[];
  affects: string[];
  tags: string[];
  assumptions: string[];
  open_questions: string[];
  dependencies: string[];
  validated_at?: string;
  validation_source?: string;
  confidence_decay_rate: number;
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown>;
  embedding?: number[];
}

export interface CreateDecisionInput {
  project_id: string;
  title: string;
  description: string;
  reasoning: string;
  made_by: string;
  source?: DecisionSource;
  source_session_id?: string;
  confidence?: ConfidenceLevel;
  status?: DecisionStatus;
  supersedes_id?: string;
  alternatives_considered?: Alternative[];
  affects?: string[];
  tags?: string[];
  assumptions?: string[];
  open_questions?: string[];
  dependencies?: string[];
  confidence_decay_rate?: number;
  metadata?: Record<string, unknown>;
}

export type DecisionSource = 'manual' | 'auto_distilled' | 'imported';
export type ConfidenceLevel = 'high' | 'medium' | 'low';
export type DecisionStatus = 'active' | 'superseded' | 'reverted' | 'pending';

export interface Alternative {
  option: string;
  rejected_reason: string;
}

export interface ScoredDecision extends Decision {
  relevance_score: number;
  freshness_score: number;
  combined_score: number;
  scoring_breakdown: ScoringBreakdown;
}

export interface ScoringBreakdown {
  direct_affect: number;
  tag_matching: number;
  role_relevance: number;
  semantic_similarity: number;
  status_penalty: number;
  freshness: number;
  combined: number;
}

// --- Edges ---
export interface DecisionEdge {
  id: string;
  source_id: string;
  target_id: string;
  relationship: EdgeRelationship;
  description?: string;
  strength: number;
  created_at: string;
}

export interface CreateEdgeInput {
  source_id: string;
  target_id: string;
  relationship: EdgeRelationship;
  description?: string;
  strength?: number;
}

export type EdgeRelationship =
  | 'supersedes'
  | 'requires'
  | 'informs'
  | 'blocks'
  | 'contradicts'
  | 'enables'
  | 'depends_on'
  | 'refines'
  | 'reverts';

export const EDGE_RELATIONSHIPS: EdgeRelationship[] = [
  'supersedes',
  'requires',
  'informs',
  'blocks',
  'contradicts',
  'enables',
  'depends_on',
  'refines',
  'reverts',
];

// --- Artifacts ---
export interface Artifact {
  id: string;
  project_id: string;
  name: string;
  path?: string;
  artifact_type: ArtifactType;
  description?: string;
  content_summary?: string;
  content_hash?: string;
  produced_by: string;
  related_decision_ids: string[];
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown>;
  embedding?: number[];
}

export interface CreateArtifactInput {
  project_id: string;
  name: string;
  path?: string;
  artifact_type: ArtifactType;
  description?: string;
  content_summary?: string;
  content_hash?: string;
  produced_by: string;
  related_decision_ids?: string[];
  metadata?: Record<string, unknown>;
}

export type ArtifactType =
  | 'spec'
  | 'code'
  | 'design'
  | 'report'
  | 'config'
  | 'documentation'
  | 'test'
  | 'other';

export interface ScoredArtifact extends Artifact {
  relevance_score: number;
}

// --- Session Summaries ---
export interface SessionSummary {
  id: string;
  project_id: string;
  agent_name: string;
  session_date: string;
  topic: string;
  summary: string;
  decision_ids: string[];
  artifact_ids: string[];
  assumptions: string[];
  open_questions: string[];
  lessons_learned: string[];
  raw_conversation_hash?: string;
  extraction_model?: string;
  extraction_confidence?: number;
  created_at: string;
  embedding?: number[];
}

export interface CreateSessionInput {
  project_id: string;
  agent_name: string;
  topic: string;
  summary: string;
  decision_ids?: string[];
  artifact_ids?: string[];
  assumptions?: string[];
  open_questions?: string[];
  lessons_learned?: string[];
  raw_conversation_hash?: string;
  extraction_model?: string;
  extraction_confidence?: number;
}

// --- Subscriptions ---
export interface Subscription {
  id: string;
  agent_id: string;
  topic: string;
  notify_on: NotifyEvent[];
  priority: Priority;
  created_at: string;
}

export interface CreateSubscriptionInput {
  agent_id: string;
  topic: string;
  notify_on?: NotifyEvent[];
  priority?: Priority;
}

export type NotifyEvent = 'update' | 'supersede' | 'revert' | 'contradict';
export type Priority = 'high' | 'medium' | 'low';

// --- Notifications ---
export interface Notification {
  id: string;
  agent_id: string;
  decision_id?: string;
  notification_type: NotificationType;
  message: string;
  role_context?: string;
  urgency: Urgency;
  read_at?: string;
  created_at: string;
}

export type NotificationType =
  | 'decision_created'
  | 'decision_updated'
  | 'decision_superseded'
  | 'decision_reverted'
  | 'artifact_updated'
  | 'blocked'
  | 'unblocked'
  | 'contradiction_detected'
  | 'assumption_invalidated'
  | 'dependency_changed';

export type Urgency = 'critical' | 'high' | 'medium' | 'low';

// --- Context Compiler ---
export interface CompileRequest {
  agent_name: string;
  project_id: string;
  task_description: string;
  max_tokens?: number;
  include_superseded?: boolean;
  session_lookback_days?: number;
}

export interface ContextPackage {
  agent: { name: string; role: string };
  task: string;
  compiled_at: string;
  token_count: number;
  budget_used_pct: number;
  decisions: ScoredDecision[];
  artifacts: ScoredArtifact[];
  notifications: Notification[];
  recent_sessions: SessionSummary[];
  formatted_markdown: string;
  formatted_json: string;
  decisions_considered: number;
  decisions_included: number;
  relevance_threshold_used: number;
  compilation_time_ms: number;
}

// --- Contradictions ---
export interface Contradiction {
  id: string;
  project_id: string;
  decision_a_id: string;
  decision_b_id: string;
  similarity_score: number;
  conflict_description?: string;
  status: ContradictionStatus;
  resolved_by?: string;
  resolution?: string;
  detected_at: string;
  resolved_at?: string;
}

export type ContradictionStatus = 'unresolved' | 'resolved' | 'dismissed';

// --- Relevance Feedback ---
export interface RelevanceFeedback {
  id: string;
  agent_id: string;
  decision_id: string;
  compile_request_id?: string;
  was_useful: boolean;
  usage_signal?: UsageSignal;
  created_at: string;
}

export interface CreateFeedbackInput {
  agent_id: string;
  decision_id: string;
  compile_request_id?: string;
  was_useful: boolean;
  usage_signal?: UsageSignal;
}

export type UsageSignal = 'referenced' | 'ignored' | 'contradicted' | 'built_upon';

// --- Graph Traversal ---
export interface GraphNode {
  decision: Decision;
  depth: number;
  via_relationship: string;
}

export interface GraphResult {
  nodes: Decision[];
  edges: DecisionEdge[];
}

// --- Impact Analysis ---
export interface ImpactAnalysis {
  decision: Decision;
  downstream_decisions: Decision[];
  affected_agents: Agent[];
  cached_contexts_invalidated: number;
  blocking_decisions: Decision[];
  supersession_chain: Decision[];
}

// --- Distillery ---
export interface DistilleryResult {
  decisions_extracted: number;
  contradictions_found: number;
  decisions: Decision[];
  session_summary?: SessionSummary;
}

export interface ExtractedDecision {
  title: string;
  description: string;
  reasoning: string;
  alternatives_considered: Alternative[];
  confidence: ConfidenceLevel;
  tags: string[];
  affects: string[];
  assumptions: string[];
  open_questions: string[];
  dependencies: string[];
  implicit: boolean;
}

// --- Audit Log ---
export interface AuditEntry {
  id: string;
  event_type: string;
  agent_id?: string;
  project_id?: string;
  decision_id?: string;
  details: Record<string, unknown>;
  created_at: string;
}

// --- API Keys ---
export interface ApiKey {
  id: string;
  key_hash: string;
  project_id: string;
  name: string;
  scopes: string[];
  last_used_at?: string;
  created_at: string;
  revoked_at?: string;
}

// --- Project Stats ---
export interface ProjectStats {
  total_decisions: number;
  active_decisions: number;
  superseded_decisions: number;
  pending_decisions: number;
  total_agents: number;
  total_artifacts: number;
  total_sessions: number;
  unresolved_contradictions: number;
  total_edges: number;
  recent_activity: AuditEntry[];
}

// --- Error Types ---
export class DeciGraphError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 500,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'DeciGraphError';
  }
}

export class NotFoundError extends DeciGraphError {
  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`, 'NOT_FOUND', 404);
  }
}

export class ValidationError extends DeciGraphError {
  constructor(message: string, details?: unknown) {
    super(message, 'VALIDATION_ERROR', 400, details);
  }
}

export class ConflictError extends DeciGraphError {
  constructor(message: string) {
    super(message, 'CONFLICT', 409);
  }
}
