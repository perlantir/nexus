/**
 * DeciGraph — simplified facade for the SDK.
 *
 * Wraps DeciGraphClient with a friendlier API that auto-fills project_id
 * and provides the 5 core operations: compile, addDecision, ask, search,
 * getContradictions.
 *
 * Two modes:
 *   HTTP mode:   new DeciGraph({ baseUrl: 'http://localhost:3100' })
 *   Direct mode: new DeciGraph({ databaseUrl: 'postgresql://...' })
 */
import { DeciGraphClient } from './client.js';
import type {
  Decision,
  Contradiction,
  ContextPackage,
} from './types.js';

export interface DeciGraphConfig {
  /** HTTP API URL (e.g., http://localhost:3100) */
  baseUrl?: string;
  /** Direct PostgreSQL connection string (bypasses HTTP) */
  databaseUrl?: string;
  /** API key for HTTP mode */
  apiKey?: string;
  /** Default project ID — auto-detected if not set */
  projectId?: string;
}

export interface CompileOptions {
  agentName: string;
  taskDescription: string;
  projectId?: string;
  depth?: number;
}

export interface AddDecisionOptions {
  title: string;
  description?: string;
  tags?: string[];
  affects?: string[];
  confidence?: 'high' | 'medium' | 'low';
  projectId?: string;
}

export interface SearchOptions {
  query?: string;
  tags?: string[];
  agent?: string;
  status?: 'active' | 'superseded' | 'reverted' | 'pending';
  limit?: number;
  projectId?: string;
}

export class DeciGraph {
  private client: DeciGraphClient;
  private defaultProjectId: string;

  constructor(config: DeciGraphConfig) {
    if (config.databaseUrl) {
      // Direct mode — still uses HTTP client but against localhost
      // The MCP server handles direct DB; SDK facade always uses HTTP
      console.warn('[DeciGraph] Direct DB mode not yet supported in SDK — use baseUrl with the API server');
    }

    this.client = new DeciGraphClient({
      baseUrl: config.baseUrl ?? process.env.DECIGRAPH_URL ?? 'http://localhost:3100',
      apiKey: config.apiKey ?? process.env.DECIGRAPH_API_KEY,
    });

    this.defaultProjectId = config.projectId
      ?? process.env.DECIGRAPH_PROJECT_ID
      ?? '';
  }

  /** Get the underlying HTTP client for advanced operations */
  getClient(): DeciGraphClient {
    return this.client;
  }

  private pid(override?: string): string {
    const id = override ?? this.defaultProjectId;
    if (!id) throw new Error('No project_id provided. Set projectId in config or DECIGRAPH_PROJECT_ID env var.');
    return id;
  }

  /** Compile scored, relevant decisions for an agent + task */
  async compile(opts: CompileOptions): Promise<ContextPackage> {
    return this.client.compileContext({
      agent_name: opts.agentName,
      task_description: opts.taskDescription,
      project_id: this.pid(opts.projectId),
      max_tokens: opts.depth ? opts.depth * 16000 : undefined,
    });
  }

  /** Record a new decision */
  async addDecision(opts: AddDecisionOptions): Promise<Decision> {
    return this.client.createDecision(this.pid(opts.projectId), {
      title: opts.title,
      description: opts.description ?? '',
      reasoning: '',
      made_by: 'sdk',
      source: 'manual',
      tags: opts.tags ?? [],
      affects: opts.affects ?? [],
      confidence: opts.confidence ?? 'high',
    });
  }

  /** Ask a natural language question about decisions */
  async ask(
    question: string,
    projectId?: string,
  ): Promise<{ answer: string; sources: Array<{ id: string; title: string; score: number }>; tokens_used: number }> {
    return this.client.ask(this.pid(projectId), question);
  }

  /** Search and filter decisions */
  async search(opts: SearchOptions = {}): Promise<Decision[]> {
    if (opts.query) {
      return this.client.searchDecisions(
        this.pid(opts.projectId),
        opts.query,
        opts.limit ?? 10,
      );
    }

    return this.client.listDecisions(this.pid(opts.projectId), {
      status: opts.status,
      limit: opts.limit ?? 10,
    });
  }

  /** Get decisions that contradict each other */
  async getContradictions(projectId?: string): Promise<Contradiction[]> {
    return this.client.getContradictions(this.pid(projectId));
  }
}
