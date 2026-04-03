# API Reference

The Nexus REST API is built with [Hono](https://hono.dev) and runs on port 3100 by default.

**Base URL:** `http://localhost:3100`

---

## Authentication

All endpoints accept an optional Bearer token. Set `NEXUS_API_KEY` in `.env` and pass it with requests:

```
Authorization: Bearer <your-api-key>
```

When `NEXUS_API_KEY` is unset, authentication is disabled (development mode). In production, always set a secret and pass it with all requests.

---

## Error Envelope

All error responses use a consistent JSON envelope:

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Decision not found: abc-123",
    "details": null
  }
}
```

### Error codes

| HTTP Status | Code | Description |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Missing or invalid request fields |
| 401 | `UNAUTHORIZED` | Missing or invalid bearer token |
| 404 | `NOT_FOUND` | Requested resource does not exist |
| 409 | `CONFLICT` | Duplicate resource (e.g. agent name already used in project) |
| 422 | `UNPROCESSABLE_ENTITY` | Request is valid but cannot be processed |
| 429 | `RATE_LIMITED` | Too many requests |
| 500 | `INTERNAL_ERROR` | Unexpected server error |

---

## Health

### GET /api/health

Returns server health status. No authentication required.

**Response 200**
```json
{
  "status": "ok",
  "version": "0.1.0",
  "timestamp": "2026-04-03T04:00:00.000Z"
}
```

```bash
curl http://localhost:3100/api/health
```

---

## Projects

### POST /api/projects

Create a new project.

**Request body**
```json
{
  "name": "my-project",
  "description": "Optional description",
  "metadata": {}
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | ✓ | Project name |
| `description` | string | — | Free-text description |
| `metadata` | object | — | Arbitrary JSON metadata |

**Response 201**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "my-project",
  "description": "Optional description",
  "created_at": "2026-04-03T04:00:00.000Z",
  "updated_at": "2026-04-03T04:00:00.000Z",
  "metadata": {}
}
```

```bash
curl -X POST http://localhost:3100/api/projects \
  -H "Content-Type: application/json" \
  -d '{"name": "my-project"}'
```

---

### GET /api/projects/:id

Fetch a project by ID.

**Response 200** — Project object (same shape as POST response)

```bash
curl http://localhost:3100/api/projects/550e8400-e29b-41d4-a716-446655440000
```

---

### GET /api/projects/:id/stats

Returns decision counts, agent counts, and recent audit activity.

**Response 200**
```json
{
  "total_decisions": 42,
  "active_decisions": 38,
  "superseded_decisions": 3,
  "pending_decisions": 1,
  "total_agents": 5,
  "total_artifacts": 12,
  "total_sessions": 18,
  "unresolved_contradictions": 2,
  "total_edges": 61,
  "recent_activity": [
    {
      "id": "uuid",
      "event_type": "decision_created",
      "agent_id": "uuid",
      "project_id": "uuid",
      "decision_id": "uuid",
      "details": {},
      "created_at": "2026-04-03T04:00:00.000Z"
    }
  ]
}
```

```bash
curl http://localhost:3100/api/projects/$PROJECT_ID/stats
```

---

### GET /api/projects/:id/graph

Returns the full decision graph for a project (all nodes and edges).

**Response 200**
```json
{
  "nodes": [ /* Decision[] */ ],
  "edges": [ /* DecisionEdge[] */ ]
}
```

```bash
curl http://localhost:3100/api/projects/$PROJECT_ID/graph
```

---

## Agents

### POST /api/projects/:projectId/agents

Register an agent within a project.

**Request body**
```json
{
  "name": "alice",
  "role": "architect",
  "context_budget_tokens": 50000,
  "relevance_profile": {
    "weights": {
      "architecture": 1.0,
      "api": 0.9,
      "database": 0.8
    },
    "decision_depth": 3,
    "freshness_preference": "balanced",
    "include_superseded": true
  }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | ✓ | Unique agent name within project |
| `role` | string | ✓ | Role key (`architect`, `builder`, etc.) or custom string |
| `context_budget_tokens` | integer | — | Token budget (default 50000) |
| `relevance_profile` | object | — | Override the role template's profile |

If `relevance_profile` is omitted, the built-in role template for `role` is used. If no template matches, the `builder` template is used as a fallback.

**Response 201** — Agent object

```json
{
  "id": "uuid",
  "project_id": "uuid",
  "name": "alice",
  "role": "architect",
  "relevance_profile": {
    "weights": {"architecture": 1.0, "api": 0.9, ...},
    "decision_depth": 3,
    "freshness_preference": "balanced",
    "include_superseded": true
  },
  "context_budget_tokens": 50000,
  "created_at": "...",
  "updated_at": "..."
}
```

```bash
curl -X POST http://localhost:3100/api/projects/$PROJECT_ID/agents \
  -H "Content-Type: application/json" \
  -d '{"name": "alice", "role": "architect"}'
```

---

### GET /api/projects/:projectId/agents

List all agents in a project.

**Response 200** — `Agent[]`

---

## Decisions

### POST /api/projects/:projectId/decisions

Record a new decision.

**Request body**
```json
{
  "title": "Use PostgreSQL as primary database",
  "description": "All persistent state lives in PostgreSQL 17.",
  "reasoning": "Team familiarity, strong JSON support, pgvector for embeddings.",
  "made_by": "alice",
  "source": "manual",
  "confidence": "high",
  "status": "active",
  "supersedes_id": null,
  "alternatives_considered": [
    {"option": "MongoDB", "rejected_reason": "No built-in vector search"}
  ],
  "affects": ["builder", "ops"],
  "tags": ["database", "architecture"],
  "assumptions": ["Cloud provider supports PostgreSQL 17"],
  "open_questions": ["What backup frequency is needed?"],
  "dependencies": [],
  "confidence_decay_rate": 0.0,
  "metadata": {}
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `title` | string | ✓ | Short decision title |
| `description` | string | ✓ | What was decided |
| `reasoning` | string | ✓ | Why this decision was made |
| `made_by` | string | ✓ | Agent or human name |
| `source` | enum | — | `manual` (default), `auto_distilled`, `imported` |
| `confidence` | enum | — | `high` (default), `medium`, `low` |
| `status` | enum | — | `active` (default), `superseded`, `reverted`, `pending` |
| `supersedes_id` | UUID | — | ID of decision this replaces |
| `alternatives_considered` | array | — | `[{option, rejected_reason}]` |
| `affects` | string[] | — | Component or agent names affected |
| `tags` | string[] | — | Domain taxonomy labels |
| `assumptions` | string[] | — | Assumed conditions |
| `open_questions` | string[] | — | Unresolved questions |
| `dependencies` | string[] | — | Decision IDs or external deps |
| `confidence_decay_rate` | float | — | Daily freshness decay multiplier (default 0.0) |
| `metadata` | object | — | Arbitrary JSON |

**Response 201** — Full `Decision` object including auto-generated `id`, `created_at`, `updated_at`, and `embedding`.

```bash
curl -X POST http://localhost:3100/api/projects/$PROJECT_ID/decisions \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Use PostgreSQL",
    "description": "PostgreSQL 17 is the primary database.",
    "reasoning": "Team expertise and pgvector support.",
    "made_by": "alice",
    "tags": ["database"],
    "affects": ["builder"]
  }'
```

---

### GET /api/projects/:projectId/decisions

List decisions with optional filters.

**Query parameters**

| Parameter | Type | Description |
|---|---|---|
| `status` | enum | Filter by `active`, `superseded`, `reverted`, or `pending` |
| `tags` | string | Comma-separated tag list (decisions must have at least one) |
| `made_by` | string | Filter by agent name |
| `limit` | integer | Max results (default 50) |
| `offset` | integer | Pagination offset (default 0) |

**Response 200** — `Decision[]`

```bash
curl "http://localhost:3100/api/projects/$PROJECT_ID/decisions?status=active&tags=database,architecture&limit=20"
```

---

### GET /api/decisions/:id

Fetch a single decision by ID.

**Response 200** — `Decision` object

```bash
curl http://localhost:3100/api/decisions/$DECISION_ID
```

---

### PATCH /api/decisions/:id

Update mutable fields of a decision. Partial updates are supported — only provided fields are changed. Embedding is regenerated automatically if `title`, `description`, `reasoning`, `tags`, or `affects` change.

**Request body** — any subset of decision fields

```json
{
  "confidence": "medium",
  "open_questions": ["Is the backup strategy defined?", "What is the max DB size?"],
  "tags": ["database", "architecture", "compliance"]
}
```

**Response 200** — Updated `Decision` object

```bash
curl -X PATCH http://localhost:3100/api/decisions/$DECISION_ID \
  -H "Content-Type: application/json" \
  -d '{"status": "pending", "open_questions": ["Waiting for compliance review"]}'
```

---

### POST /api/decisions/:id/supersede

Create a new decision that supersedes an existing one. This is a single atomic operation that:
1. Creates the new decision.
2. Marks the old decision as `superseded`.
3. Creates a `supersedes` edge from new → old.

**Request body** — same fields as `POST /api/projects/:id/decisions`

**Response 201**
```json
{
  "newDecision": { /* full Decision object */ },
  "oldDecision": { /* old Decision with status='superseded' */ }
}
```

```bash
curl -X POST http://localhost:3100/api/decisions/$OLD_DECISION_ID/supersede \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Use CockroachDB instead of PostgreSQL",
    "description": "Switching to CockroachDB for global distribution.",
    "reasoning": "Horizontal scaling requirements emerged from load testing.",
    "made_by": "alice",
    "tags": ["database", "architecture"],
    "affects": ["builder", "ops"]
  }'
```

---

### POST /api/projects/:projectId/decisions/search

Semantic search over decisions using vector similarity.

**Request body**
```json
{
  "query": "how do we handle authentication?",
  "limit": 10
}
```

**Response 200** — `Decision[]` ordered by semantic similarity

```bash
curl -X POST http://localhost:3100/api/projects/$PROJECT_ID/decisions/search \
  -H "Content-Type: application/json" \
  -d '{"query": "database connection pooling strategy", "limit": 5}'
```

---

### GET /api/decisions/:id/graph

Returns the decision subgraph rooted at the given decision.

**Query parameters**

| Parameter | Type | Description |
|---|---|---|
| `depth` | integer | Traversal depth (default 2, max 5) |

**Response 200**
```json
{
  "nodes": [ /* Decision[] */ ],
  "edges": [ /* DecisionEdge[] */ ]
}
```

```bash
curl "http://localhost:3100/api/decisions/$DECISION_ID/graph?depth=3"
```

---

### GET /api/decisions/:id/impact

Analyse the downstream impact of a decision.

**Response 200**
```json
{
  "decision": { /* Decision */ },
  "downstream_decisions": [ /* Decision[] */ ],
  "affected_agents": [ /* Agent[] */ ],
  "cached_contexts_invalidated": 3,
  "blocking_decisions": [ /* Decision[] */ ],
  "supersession_chain": [ /* Decision[] */ ]
}
```

```bash
curl http://localhost:3100/api/decisions/$DECISION_ID/impact
```

---

## Decision Edges

### POST /api/decisions/:decisionId/edges

Create an edge between two decisions.

**Request body**
```json
{
  "target_id": "uuid-of-target-decision",
  "relationship": "requires",
  "description": "Requires the database decision to be active",
  "strength": 1.0
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `target_id` | UUID | ✓ | Target decision ID |
| `relationship` | enum | ✓ | One of: `supersedes`, `requires`, `informs`, `blocks`, `contradicts`, `enables`, `depends_on`, `refines`, `reverts` |
| `description` | string | — | Human-readable edge description |
| `strength` | float | — | Edge strength 0..1 (default 1.0) |

**Response 201** — `DecisionEdge` object

```bash
curl -X POST http://localhost:3100/api/decisions/$DECISION_A/edges \
  -H "Content-Type: application/json" \
  -d '{
    "target_id": "'$DECISION_B'",
    "relationship": "requires",
    "strength": 0.9
  }'
```

---

### GET /api/decisions/:decisionId/edges

List all edges connected to a decision (as source or target).

**Response 200** — `DecisionEdge[]`

---

### DELETE /api/edges/:id

Delete an edge by ID.

**Response 200**
```json
{"deleted": true, "id": "edge-uuid"}
```

---

## Artifacts

### POST /api/projects/:projectId/artifacts

Record a new artifact.

**Request body**
```json
{
  "name": "auth-service.ts",
  "path": "src/services/auth-service.ts",
  "artifact_type": "code",
  "description": "JWT authentication service implementation",
  "content_summary": "Implements login, token refresh, and logout endpoints",
  "produced_by": "builder-agent",
  "related_decision_ids": ["uuid-1", "uuid-2"],
  "metadata": {}
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | ✓ | Artifact name |
| `artifact_type` | enum | ✓ | `spec`, `code`, `design`, `report`, `config`, `documentation`, `test`, `other` |
| `produced_by` | string | ✓ | Agent or human name |
| `path` | string | — | File system path |
| `description` | string | — | Human description |
| `content_summary` | string | — | Content summary for context compilation |
| `related_decision_ids` | UUID[] | — | Decisions this artifact implements |
| `metadata` | object | — | Arbitrary JSON |

**Response 201** — `Artifact` object

---

### GET /api/projects/:projectId/artifacts

List all artifacts in a project.

**Response 200** — `Artifact[]`

---

## Context Compiler

### POST /api/compile

Compile a ranked context package for an agent. Agents call this at the start of every task.

**Request body**
```json
{
  "agent_name": "alice",
  "project_id": "uuid",
  "task_description": "Implement the user authentication service",
  "max_tokens": 50000,
  "include_superseded": false,
  "session_lookback_days": 7
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `agent_name` | string | ✓ | Name of the requesting agent |
| `project_id` | UUID | ✓ | Project scope |
| `task_description` | string | ✓ | Natural-language task description (used for embedding) |
| `max_tokens` | integer | — | Token budget override (defaults to agent's `context_budget_tokens`) |
| `include_superseded` | boolean | — | Include superseded decisions (defaults to agent's profile setting) |
| `session_lookback_days` | integer | — | How many days of session history to include (default 7) |

**Response 200**
```json
{
  "agent": {"name": "alice", "role": "architect"},
  "task": "Implement the user authentication service",
  "compiled_at": "2026-04-03T04:00:00.000Z",
  "token_count": 12500,
  "budget_used_pct": 25,
  "decisions": [ /* ScoredDecision[] */ ],
  "artifacts": [ /* ScoredArtifact[] */ ],
  "notifications": [ /* Notification[] */ ],
  "recent_sessions": [ /* SessionSummary[] */ ],
  "formatted_markdown": "# Context for alice (architect)\n...",
  "formatted_json": "{...}",
  "decisions_considered": 42,
  "decisions_included": 8,
  "relevance_threshold_used": 0,
  "compilation_time_ms": 145
}
```

`ScoredDecision` extends `Decision` with:
```json
{
  "relevance_score": 0.72,
  "freshness_score": 0.95,
  "combined_score": 0.72,
  "scoring_breakdown": {
    "direct_affect": 0.40,
    "tag_matching": 0.15,
    "role_relevance": 0.075,
    "semantic_similarity": 0.095,
    "status_penalty": 1.0,
    "freshness": 0.95,
    "combined": 0.72
  }
}
```

```bash
curl -X POST http://localhost:3100/api/compile \
  -H "Content-Type: application/json" \
  -d '{
    "agent_name": "alice",
    "project_id": "'$PROJECT_ID'",
    "task_description": "Design the authentication system"
  }' | jq -r .formatted_markdown
```

---

## Distillery

### POST /api/projects/:projectId/distill

Extract decisions from a raw conversation transcript.

**Request body**
```json
{
  "conversation_text": "User: Use JWT for auth...\nAssistant: Agreed. HS256 for internal services...",
  "session_id": "optional-uuid",
  "agent_name": "alice"
}
```

**Response 200**
```json
{
  "decisions_extracted": 3,
  "contradictions_found": 0,
  "decisions": [ /* Decision[] */ ],
  "session_summary": null
}
```

```bash
curl -X POST http://localhost:3100/api/projects/$PROJECT_ID/distill \
  -H "Content-Type: application/json" \
  -d '{
    "conversation_text": "We decided to use Redis for session cache with 24h TTL.",
    "agent_name": "alice"
  }'
```

---

### POST /api/projects/:projectId/distill/session

Same as `/distill` but also creates a `SessionSummary` record linking all extracted decisions.

**Additional request fields**
```json
{
  "topic": "Authentication design session"
}
```

**Response 200** — same as `/distill` but `session_summary` is populated.

---

## Sessions

### POST /api/projects/:projectId/sessions

Create a session summary record.

**Request body**
```json
{
  "agent_name": "alice",
  "topic": "Authentication service design",
  "summary": "Designed the JWT auth service with Redis session cache.",
  "decision_ids": ["uuid-1", "uuid-2"],
  "artifact_ids": [],
  "assumptions": ["Redis will be available in production"],
  "open_questions": ["How should token revocation work?"],
  "lessons_learned": ["HS256 is sufficient for internal services"],
  "raw_conversation_hash": "sha256-hash-of-raw-text",
  "extraction_model": "claude-3-5-sonnet",
  "extraction_confidence": 0.92
}
```

**Response 201** — `SessionSummary` object

---

### GET /api/projects/:projectId/sessions

List session summaries for a project.

**Response 200** — `SessionSummary[]`

---

## Notifications

### GET /api/agents/:agentId/notifications

Get notifications for an agent.

**Query parameters**

| Parameter | Description |
|---|---|
| `unread` | `true` to return only unread notifications |

**Response 200** — `Notification[]`

```json
[
  {
    "id": "uuid",
    "agent_id": "uuid",
    "decision_id": "uuid",
    "notification_type": "decision_superseded",
    "message": "The database choice has been superseded. Your implementation may need updating.",
    "role_context": "Check if your implementation aligns with this change.",
    "urgency": "high",
    "read_at": null,
    "created_at": "2026-04-03T04:00:00.000Z"
  }
]
```

```bash
curl "http://localhost:3100/api/agents/$AGENT_ID/notifications?unread=true"
```

---

### PATCH /api/notifications/:id/read

Mark a notification as read.

**Response 200** — Updated `Notification` object

```bash
curl -X PATCH http://localhost:3100/api/notifications/$NOTIFICATION_ID/read
```

---

## Subscriptions

### POST /api/agents/:agentId/subscriptions

Subscribe an agent to a topic.

**Request body**
```json
{
  "topic": "authentication",
  "notify_on": ["update", "supersede", "revert", "contradict"],
  "priority": "high"
}
```

**Response 201** — `Subscription` object

---

### GET /api/agents/:agentId/subscriptions

List all subscriptions for an agent.

**Response 200** — `Subscription[]`

---

### DELETE /api/subscriptions/:id

Remove a subscription.

**Response 200**
```json
{"deleted": true, "id": "subscription-uuid"}
```

---

## Contradictions

### GET /api/projects/:projectId/contradictions

List detected contradictions.

**Query parameters**

| Parameter | Description |
|---|---|
| `status` | `unresolved`, `resolved`, or `dismissed` |

**Response 200**
```json
[
  {
    "id": "uuid",
    "project_id": "uuid",
    "decision_a_id": "uuid",
    "decision_b_id": "uuid",
    "similarity_score": 0.94,
    "conflict_description": "Both decisions describe the caching strategy but contradict each other on TTL.",
    "status": "unresolved",
    "resolved_by": null,
    "resolution": null,
    "detected_at": "2026-04-03T04:00:00.000Z",
    "resolved_at": null
  }
]
```

---

### PATCH /api/contradictions/:id

Resolve or dismiss a contradiction.

**Request body**
```json
{
  "status": "resolved",
  "resolved_by": "alice",
  "resolution": "Decision A was superseded by Decision B. No conflict remains."
}
```

**Response 200** — Updated `Contradiction` object

---

## Feedback

### POST /api/feedback

Record relevance feedback for a decision.

**Request body**
```json
{
  "agent_id": "uuid",
  "decision_id": "uuid",
  "compile_request_id": "optional-hash",
  "was_useful": true,
  "usage_signal": "referenced"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `agent_id` | UUID | ✓ | Agent providing feedback |
| `decision_id` | UUID | ✓ | Decision being rated |
| `was_useful` | boolean | ✓ | Was this decision helpful? |
| `usage_signal` | enum | — | `referenced`, `ignored`, `contradicted`, `built_upon` |
| `compile_request_id` | string | — | Task hash from the compile response |

**Response 201** — `RelevanceFeedback` object

```bash
curl -X POST http://localhost:3100/api/feedback \
  -H "Content-Type: application/json" \
  -d '{
    "agent_id": "'$AGENT_ID'",
    "decision_id": "'$DECISION_ID'",
    "was_useful": true,
    "usage_signal": "built_upon"
  }'
```

---

## Audit Log

### GET /api/projects/:projectId/audit

Retrieve audit log entries for a project.

**Query parameters**

| Parameter | Description |
|---|---|
| `event_type` | Filter by event type (e.g. `decision_created`, `context_compiled`) |
| `limit` | Max entries to return (default 50) |

**Response 200** — `AuditEntry[]`

```json
[
  {
    "id": "uuid",
    "event_type": "context_compiled",
    "agent_id": "uuid",
    "project_id": "uuid",
    "decision_id": null,
    "details": {
      "agent_name": "alice",
      "task_description": "Design auth system",
      "decisions_considered": 42,
      "decisions_included": 8,
      "token_count": 12500,
      "compilation_time_ms": 145
    },
    "created_at": "2026-04-03T04:00:00.000Z"
  }
]
```

---

## API Keys

### POST /api/projects/:projectId/api-keys

Create an API key scoped to a project.

**Request body**
```json
{
  "name": "ci-pipeline",
  "scopes": ["read", "write"]
}
```

**Response 201**
```json
{
  "id": "uuid",
  "key": "nx_live_...",
  "name": "ci-pipeline",
  "scopes": ["read", "write"],
  "created_at": "..."
}
```

> The full key is only returned once. Store it securely.

---

### DELETE /api/api-keys/:id

Revoke an API key.

**Response 200**
```json
{"revoked": true, "id": "key-uuid"}
```
