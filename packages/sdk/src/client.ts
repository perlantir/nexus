import {
  DeciGraphApiError,
  type DeciGraphClientOptions,
  type Project,
  type CreateProjectInput,
  type Agent,
  type CreateAgentInput,
  type Decision,
  type CreateDecisionInput,
  type UpdateDecisionInput,
  type SupersedeDecisionInput,
  type DecisionListFilters,
  type DecisionEdge,
  type CreateEdgeInput,
  type Artifact,
  type CreateArtifactInput,
  type SessionSummary,
  type CreateSessionInput,
  type Subscription,
  type CreateSubscriptionInput,
  type Notification,
  type CompileContextInput,
  type ContextPackage,
  type DistillInput,
  type DistilleryResult,
  type Contradiction,
  type ResolveContradictionInput,
  type CreateFeedbackInput,
  type RelevanceFeedback,
  type GraphResult,
  type ImpactAnalysis,
  type ProjectStats,
  type AuditEntry,
} from './types.js';

export class DeciGraphClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;

  constructor(opts: DeciGraphClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
  }

  private buildHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...extra,
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    queryParams?: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    let url = `${this.baseUrl}${path}`;

    if (queryParams) {
      const search = new URLSearchParams();
      for (const [k, v] of Object.entries(queryParams)) {
        if (v !== undefined) search.set(k, String(v));
      }
      const qs = search.toString();
      if (qs) url += `?${qs}`;
    }

    const opts: RequestInit = {
      method,
      headers: this.buildHeaders(),
    };

    if (body !== undefined) {
      opts.body = JSON.stringify(body);
    }

    let res: Response;
    try {
      res = await fetch(url, opts);
    } catch (err) {
      throw new DeciGraphApiError(`Network error: ${(err as Error).message}`, 'NETWORK_ERROR', 0);
    }

    if (!res.ok) {
      let errorBody: { error?: { code?: string; message?: string; details?: unknown } } = {};
      try {
        errorBody = (await res.json()) as typeof errorBody;
      } catch {
        // ignore parse errors
      }
      const code = errorBody.error?.code ?? 'API_ERROR';
      const message = errorBody.error?.message ?? res.statusText;
      throw new DeciGraphApiError(message, code, res.status, errorBody.error?.details);
    }

    // 204 No Content
    if (res.status === 204) {
      return undefined as unknown as T;
    }

    return res.json() as Promise<T>;
  }

  private get<T>(
    path: string,
    queryParams?: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    return this.request<T>('GET', path, undefined, queryParams);
  }

  private post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  private patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }

  private delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  // Health

  health(): Promise<{ status: string; version: string; timestamp: string }> {
    return this.get('/api/health');
  }

  // Projects

  createProject(input: CreateProjectInput): Promise<Project> {
    return this.post<Project>('/api/projects', input);
  }

  getProject(id: string): Promise<Project> {
    return this.get<Project>(`/api/projects/${id}`);
  }

  // Agents

  createAgent(projectId: string, input: CreateAgentInput): Promise<Agent> {
    return this.post<Agent>(`/api/projects/${projectId}/agents`, input);
  }

  listAgents(projectId: string): Promise<Agent[]> {
    return this.get<Agent[]>(`/api/projects/${projectId}/agents`);
  }

  // Decisions

  createDecision(projectId: string, input: CreateDecisionInput): Promise<Decision> {
    return this.post<Decision>(`/api/projects/${projectId}/decisions`, input);
  }

  getDecision(id: string): Promise<Decision> {
    return this.get<Decision>(`/api/decisions/${id}`);
  }

  listDecisions(projectId: string, filters?: DecisionListFilters): Promise<Decision[]> {
    const queryParams: Record<string, string | number | boolean | undefined> = {};
    if (filters?.status) queryParams.status = filters.status;
    if (filters?.tags?.length) queryParams.tags = filters.tags.join(',');
    if (filters?.made_by) queryParams.made_by = filters.made_by;
    if (filters?.limit !== undefined) queryParams.limit = filters.limit;
    if (filters?.offset !== undefined) queryParams.offset = filters.offset;

    return this.get<Decision[]>(`/api/projects/${projectId}/decisions`, queryParams);
  }

  updateDecision(id: string, input: UpdateDecisionInput): Promise<Decision> {
    return this.patch<Decision>(`/api/decisions/${id}`, input);
  }

  searchDecisions(projectId: string, queryText: string, limit?: number): Promise<Decision[]> {
    return this.post<Decision[]>(`/api/projects/${projectId}/decisions/search`, {
      query: queryText,
      limit,
    });
  }

  supersedeDecision(
    id: string,
    input: SupersedeDecisionInput,
  ): Promise<{ newDecision: Decision; oldDecision: Decision }> {
    return this.post<{ newDecision: Decision; oldDecision: Decision }>(
      `/api/decisions/${id}/supersede`,
      input,
    );
  }

  getGraph(id: string, depth?: number): Promise<GraphResult> {
    return this.get<GraphResult>(
      `/api/decisions/${id}/graph`,
      depth !== undefined ? { depth } : undefined,
    );
  }

  getImpact(id: string): Promise<ImpactAnalysis> {
    return this.get<ImpactAnalysis>(`/api/decisions/${id}/impact`);
  }

  // Edges

  createEdge(decisionId: string, input: CreateEdgeInput): Promise<DecisionEdge> {
    return this.post<DecisionEdge>(`/api/decisions/${decisionId}/edges`, input);
  }

  listEdges(decisionId: string): Promise<DecisionEdge[]> {
    return this.get<DecisionEdge[]>(`/api/decisions/${decisionId}/edges`);
  }

  deleteEdge(edgeId: string): Promise<{ deleted: boolean; id: string }> {
    return this.delete<{ deleted: boolean; id: string }>(`/api/edges/${edgeId}`);
  }

  // Artifacts

  createArtifact(projectId: string, input: CreateArtifactInput): Promise<Artifact> {
    return this.post<Artifact>(`/api/projects/${projectId}/artifacts`, input);
  }

  listArtifacts(projectId: string): Promise<Artifact[]> {
    return this.get<Artifact[]>(`/api/projects/${projectId}/artifacts`);
  }

  // Context Compiler

  compileContext(input: CompileContextInput): Promise<ContextPackage> {
    return this.post<ContextPackage>('/api/compile', input);
  }

  // Distillery

  distill(projectId: string, input: DistillInput): Promise<DistilleryResult> {
    return this.post<DistilleryResult>(`/api/projects/${projectId}/distill`, input);
  }

  distillSession(
    projectId: string,
    input: DistillInput & { topic?: string },
  ): Promise<DistilleryResult> {
    return this.post<DistilleryResult>(`/api/projects/${projectId}/distill/session`, input);
  }

  // Sessions

  createSession(projectId: string, input: CreateSessionInput): Promise<SessionSummary> {
    return this.post<SessionSummary>(`/api/projects/${projectId}/sessions`, input);
  }

  listSessions(projectId: string): Promise<SessionSummary[]> {
    return this.get<SessionSummary[]>(`/api/projects/${projectId}/sessions`);
  }

  // Notifications

  getNotifications(agentId: string, unreadOnly = false): Promise<Notification[]> {
    return this.get<Notification[]>(
      `/api/agents/${agentId}/notifications`,
      unreadOnly ? { unread: 'true' } : undefined,
    );
  }

  markNotificationRead(notificationId: string): Promise<Notification> {
    return this.patch<Notification>(`/api/notifications/${notificationId}/read`);
  }

  // Subscriptions

  createSubscription(agentId: string, input: CreateSubscriptionInput): Promise<Subscription> {
    return this.post<Subscription>(`/api/agents/${agentId}/subscriptions`, input);
  }

  listSubscriptions(agentId: string): Promise<Subscription[]> {
    return this.get<Subscription[]>(`/api/agents/${agentId}/subscriptions`);
  }

  deleteSubscription(subscriptionId: string): Promise<{ deleted: boolean; id: string }> {
    return this.delete<{ deleted: boolean; id: string }>(`/api/subscriptions/${subscriptionId}`);
  }

  // Contradictions

  getContradictions(
    projectId: string,
    status?: 'unresolved' | 'resolved' | 'dismissed',
  ): Promise<Contradiction[]> {
    return this.get<Contradiction[]>(
      `/api/projects/${projectId}/contradictions`,
      status ? { status } : undefined,
    );
  }

  resolveContradiction(id: string, input: ResolveContradictionInput): Promise<Contradiction> {
    return this.patch<Contradiction>(`/api/contradictions/${id}`, input);
  }

  // Feedback

  recordFeedback(input: CreateFeedbackInput): Promise<RelevanceFeedback> {
    return this.post<RelevanceFeedback>('/api/feedback', input);
  }

  // Audit

  getAuditLog(
    projectId: string,
    options?: { event_type?: string; limit?: number },
  ): Promise<AuditEntry[]> {
    return this.get<AuditEntry[]>(
      `/api/projects/${projectId}/audit`,
      options as Record<string, string | number | boolean | undefined>,
    );
  }

  // Stats & Graph

  getProjectStats(projectId: string): Promise<ProjectStats> {
    return this.get<ProjectStats>(`/api/projects/${projectId}/stats`);
  }

  getProjectGraph(projectId: string): Promise<GraphResult> {
    return this.get<GraphResult>(`/api/projects/${projectId}/graph`);
  }
}
