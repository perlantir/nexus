// SDK-local type definitions — mirrors core types without depending on @decigraph/core,
// so the SDK works in any environment (browser, edge, Node).

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
}

export interface CreateDecisionInput {
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

export interface UpdateDecisionInput {
  title?: string;
  description?: string;
  reasoning?: string;
  made_by?: string;
  confidence?: ConfidenceLevel;
  status?: DecisionStatus;
  affects?: string[];
  tags?: string[];
  assumptions?: string[];
  open_questions?: string[];
  dependencies?: string[];
  alternatives_considered?: Alternative[];
  confidence_decay_rate?: number;
  metadata?: Record<string, unknown>;
  validated_at?: string;
  validation_source?: string;
}

export interface SupersedeDecisionInput {
  title: string;
  description: string;
  reasoning: string;
  made_by: string;
  tags?: string[];
  affects?: string[];
}

export type DecisionSource = 'manual' | 'auto_distilled' | 'imported';
export type ConfidenceLevel = 'high' | 'medium' | 'low';
export type DecisionStatus = 'active' | 'superseded' | 'reverted' | 'pending';

export interface Alternative {
  option: string;
  rejected_reason: string;
}

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
}

export interface CreateArtifactInput {
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
}

export interface CreateSessionInput {
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

export interface Subscription {
  id: string;
  agent_id: string;
  topic: string;
  notify_on: NotifyEvent[];
  priority: Priority;
  created_at: string;
}

export interface CreateSubscriptionInput {
  topic: string;
  notify_on?: NotifyEvent[];
  priority?: Priority;
}

export type NotifyEvent = 'update' | 'supersede' | 'revert' | 'contradict';
export type Priority = 'high' | 'medium' | 'low';

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

export interface CompileContextInput {
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
  decisions: Decision[];
  artifacts: Artifact[];
  notifications: Notification[];
  recent_sessions: SessionSummary[];
  formatted_markdown: string;
  formatted_json: string;
  decisions_considered: number;
  decisions_included: number;
  relevance_threshold_used: number;
  compilation_time_ms: number;
}

export interface DistillInput {
  conversation_text: string;
  agent_name?: string;
  session_id?: string;
}

export interface DistilleryResult {
  decisions_extracted: number;
  contradictions_found: number;
  decisions: Decision[];
  session_summary?: SessionSummary;
}

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

export interface ResolveContradictionInput {
  status: ContradictionStatus;
  resolved_by?: string;
  resolution?: string;
}

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

export interface GraphResult {
  nodes: Decision[];
  edges: DecisionEdge[];
}

export interface ImpactAnalysis {
  decision: Decision;
  downstream_decisions: Decision[];
  affected_agents: Array<{ id: string; name: string; role: string; project_id: string }>;
  cached_contexts_invalidated: number;
  blocking_decisions: Decision[];
  supersession_chain: Decision[];
}

export interface AuditEntry {
  id: string;
  event_type: string;
  agent_id?: string;
  project_id?: string;
  decision_id?: string;
  details: Record<string, unknown>;
  created_at: string;
}

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

export interface DecisionListFilters {
  status?: DecisionStatus;
  tags?: string[];
  made_by?: string;
  limit?: number;
  offset?: number;
}

export interface DeciGraphClientOptions {
  baseUrl: string;
  apiKey?: string;
}

export interface DeciGraphError {
  code: string;
  message: string;
  details?: unknown;
}

export class DeciGraphApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DeciGraphApiError';
  }
}
