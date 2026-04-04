# Architecture

This document explains how DeciGraph works internally. Understanding the architecture helps you tune performance, extend the system, and reason about what agents will and won't see.

---

## System Overview

```
                 ┌─────────────────────────────────────────────────────┐
                 │               External Clients                       │
                 │  Claude  LangChain  CrewAI  AutoGen  CLI  REST       │
                 └──────────────────────┬──────────────────────────────┘
                                        │ HTTP + MCP
                 ┌──────────────────────▼──────────────────────────────┐
                 │              Hono REST API (port 3100)               │
                 │   Auth middleware · Audit log · CORS · Rate limit    │
                 └──────────┬──────────────────────────────┬───────────┘
                            │                              │
          ┌─────────────────▼─────┐             ┌──────────▼──────────┐
          │     Decision Graph    │             │      Distillery      │
          │  Layer 1: The Graph   │             │  Layer 4: Extraction │
          │  CRUD + traversal     │             │  LLM pipeline        │
          │  Supersession chains  │             │  Auto-capture        │
          └─────────────┬─────────┘             └──────────┬──────────┘
                        │                                  │
          ┌─────────────▼─────────────────────────────────▼──────────┐
          │                  Context Compiler                          │
          │                Layer 2: The Scorer                         │
          │   5-signal scoring · Graph expansion · Token packing       │
          │   Cache (SHA-256 keyed, 1h TTL) · Dual-format output       │
          └──────────────────────────┬─────────────────────────────────┘
                                     │
          ┌──────────────────────────▼─────────────────────────────────┐
          │               Change Propagator                             │
          │              Layer 3: Notifications                         │
          │  Subscription fan-out · Role-aware messages · Urgency       │
          └──────────────────────────┬─────────────────────────────────┘
                                     │
          ┌──────────────────────────▼─────────────────────────────────┐
          │                Temporal Engine                              │
          │               Layer 5: Time & Trust                         │
          │  Confidence decay · Freshness scores · Supersession chains  │
          └──────────────────────────┬─────────────────────────────────┘
                                     │
          ┌──────────────────────────▼─────────────────────────────────┐
          │             PostgreSQL 17 + pgvector                        │
          │  HNSW index (cosine ops) · GIN indexes · JSONB · UUID       │
          └─────────────────────────────────────────────────────────────┘
```

---

## Layer 1: Decision Graph

The Decision Graph is the core data structure of DeciGraph. It is a directed multigraph where:

- **Nodes** are `Decision` records stored in the `decisions` table.
- **Edges** are `DecisionEdge` records stored in `decision_edges`.

### Decision schema

Every decision carries:

| Field | Type | Description |
|---|---|---|
| `id` | UUID | Unique identifier |
| `title` | text | Short, descriptive title |
| `description` | text | What was decided |
| `reasoning` | text | Why this decision was made |
| `made_by` | text | Agent or human name |
| `source` | enum | `manual`, `auto_distilled`, or `imported` |
| `confidence` | enum | `high`, `medium`, or `low` |
| `status` | enum | `active`, `superseded`, `reverted`, or `pending` |
| `supersedes_id` | UUID | Points to the decision this one replaces |
| `alternatives_considered` | JSONB | `[{option, rejected_reason}]` |
| `affects` | text[] | Component / agent names affected |
| `tags` | text[] | Domain taxonomy labels |
| `assumptions` | JSONB | List of assumed conditions |
| `open_questions` | JSONB | Unresolved questions |
| `dependencies` | JSONB | Decision IDs or external dependencies |
| `confidence_decay_rate` | float | Per-day decay applied to the freshness score |
| `embedding` | vector(1536) | OpenAI `text-embedding-3-small` embedding |

### Edge relationships

| Relationship | Meaning |
|---|---|
| `supersedes` | This decision replaces the target decision |
| `requires` | This decision cannot be implemented without the target |
| `informs` | This decision provides important context for the target |
| `blocks` | This decision prevents the target from proceeding |
| `contradicts` | This decision conflicts with the target |
| `enables` | This decision makes the target possible |
| `depends_on` | This decision depends on the target being in place |
| `refines` | This decision narrows or specialises the target |
| `reverts` | This decision rolls back the target |

### Graph traversal

DeciGraph uses a recursive CTE to traverse the graph:

```sql
WITH RECURSIVE graph AS (
  SELECT target_id AS decision_id, 1 AS depth, relationship
  FROM decision_edges WHERE source_id = $1
  UNION ALL
  SELECT e.target_id, g.depth + 1, e.relationship
  FROM decision_edges e
  JOIN graph g ON e.source_id = g.decision_id
  WHERE g.depth < $2
)
SELECT DISTINCT ON (decision_id) decision_id, depth, relationship
FROM graph ORDER BY decision_id, depth;
```

A PostgreSQL stored function `get_connected_decisions($id, $depth)` wraps this query. The application falls back to the CTE if the function is absent.

---

## Layer 2: Context Compiler

The Context Compiler is the heart of DeciGraph. It takes a `CompileRequest` (agent name, project ID, task description, optional token budget) and returns a `ContextPackage` — a ranked, token-budgeted bundle of decisions, artifacts, notifications, and session summaries.

### Full pipeline

```
CompileRequest
     │
     ▼
1. Fetch agent (role, relevance_profile, context_budget_tokens)
     │
     ▼
2. Check context cache (SHA-256 of agent_id + task_description)
   → Cache hit: return immediately (1h TTL)
     │ Cache miss
     ▼
3. Fetch all decisions for project (optionally exclude superseded)
     │
     ▼
4. Generate task embedding (text-embedding-3-small)
     │
     ▼
5. Score every decision using the 5-signal algorithm
     │
     ▼
6. Graph expansion — BFS from top-N seeds, decaying score by 0.6^depth
     │
     ▼
7. Fetch and score artifacts (average score of related decisions)
     │
     ▼
8. Fetch unread notifications for agent
     │
     ▼
9. Fetch recent session summaries (within session_lookback_days)
     │
     ▼
10. Pack into token budget:
    Notifications: 10% of budget
    Decisions:     55% of budget
    Artifacts:     30% of budget
    Sessions:      remainder
     │
     ▼
11. Format as Markdown and JSON
     │
     ▼
12. Write to cache
     │
     ▼
13. Write audit log entry
     │
     ▼
ContextPackage
```

### 5-Signal Scoring Algorithm

Given agent `A` and decision `D`, the combined score is:

```
rawScore = signalA + signalB + signalC + signalD
combined = rawScore × penaltyE
```

**Signal A — Direct Affect (weight: 0.40)**

```
signalA = (agent.name ∈ D.affects OR agent.role ∈ D.affects) ? 0.40 : 0.00
```

This is the strongest signal. A decision that explicitly mentions the agent or its role is almost certainly relevant.

**Signal B — Tag Matching (weight: 0.20)**

```
matchingTags = D.tags ∩ keys(agent.relevance_profile.weights)
avgWeight    = mean(agent.relevance_profile.weights[t] for t in matchingTags)
signalB      = avgWeight × 0.20
```

Each tag in the agent's profile has a weight between 0 and 1. The average weight of matching tags is scaled to a maximum of 0.20.

**Signal C — Role Relevance (weight: 0.15)**

```
highPriorityTags = {t : agent.relevance_profile.weights[t] >= 0.8}
matches          = |D.tags ∩ highPriorityTags|
signalC          = min(1.0, matches × 0.25) × 0.15
```

This boosts decisions that match multiple high-priority tags for the role. Each additional high-priority match adds 0.25 (capped at 1.0) before the 0.15 scaling.

**Signal D — Semantic Similarity (weight: 0.25)**

```
signalD = cosine_similarity(task_embedding, D.embedding) × 0.25
```

Cosine similarity between the 1536-dimensional embeddings of the task description and the decision text (`title + description + reasoning + tags + affects`). Falls back to 0 if either embedding is missing.

**Signal E — Status Penalty (multiplier)**

| Status | Multiplier (default) | Multiplier (include_superseded=true) |
|---|---|---|
| `active` | 1.0 | 1.0 |
| `pending` | 1.0 | 1.0 |
| `superseded` | 0.1 | 0.4 |
| `reverted` | 0.05 | 0.05 |

**Example**

Agent `alice` (role: `architect`, high-priority tags: `architecture`, `api`, `database`, `performance`):

Decision: "Use PostgreSQL as primary database" with tags `["database", "architecture"]`, affects `["builder", "ops"]`.

```
signalA = 0.00  (alice not in affects)
signalB = mean(weights["database"]=0.8, weights["architecture"]=1.0) × 0.20 = 0.90 × 0.20 = 0.18
signalC = 2 high-priority matches → min(1.0, 0.5) × 0.15 = 0.075
signalD = cosine_similarity(task_embedding, decision_embedding) × 0.25 ≈ 0.22 (typical)
rawScore = 0.00 + 0.18 + 0.075 + 0.22 = 0.475
combined = 0.475 × 1.0 (active) = 0.475
```

### Graph Expansion

After scoring, the top-N decisions (where N = max(5, decision_depth × 3)) are used as seeds for a BFS traversal of the decision graph. Neighboring decisions inherit a decayed score:

```
decayed_score = parent_score × 0.6^depth
```

This pulls in related decisions (dependencies, prerequisites, enabling decisions) even if they don't score well on their own.

### Freshness Score

Freshness is a simple recency metric:

```
age_days = (now - decision.created_at) / 86400000
freshness = max(0, 1 - age_days / 365)
```

A decision created today has a freshness of 1.0. A decision created 365 days ago has a freshness of 0.0. The `confidence_decay_rate` field can accelerate this decay for volatile decisions.

### Token Budget Packing

Items are sorted by score (descending) and greedily packed into their budget slice. Token count is estimated as `ceil(text_length / 4)`. Items that don't fit are excluded — no truncation of individual items.

Budget allocation:
- Notifications: 10%
- Decisions: 55%
- Artifacts: 30%
- Sessions: remainder after packing the first three

### Cache Strategy

The context cache uses SHA-256 keying:

```
task_hash = SHA-256(agent_id + "::" + task_description)
```

Cache entries expire after 1 hour. When a decision is updated or superseded, the Change Propagator invalidates cache entries by agent whose `decision_ids_included` overlaps with the changed decision. Cache misses fall through transparently to the full compilation pipeline.

---

## Layer 3: Change Propagator

When a decision is created, updated, or superseded, the Change Propagator:

1. Identifies agents subscribed to any tag or domain matching the changed decision's `tags` or `affects`.
2. Generates a role-specific notification message using the agent's role template's `notification_context`.
3. Assigns urgency based on the change type (`critical` for contradictions, `high` for supersessions, `medium` for updates, `low` for new decisions in tangentially related domains).
4. Inserts notification records into the `notifications` table.
5. Invalidates relevant context cache entries.

### Subscription model

Agents subscribe to topics:

```json
{
  "agent_id": "uuid",
  "topic": "authentication",
  "notify_on": ["update", "supersede", "revert", "contradict"],
  "priority": "high"
}
```

Topics are matched against decision `tags` using an exact-match lookup. When a decision with tag `authentication` is superseded, every agent subscribed to `authentication` with `"supersede"` in their `notify_on` list receives a notification.

---

## Layer 4: Distillery

The Distillery processes raw conversation text through an LLM pipeline to extract structured decisions. DeciGraph is provider-agnostic: all LLM calls (embeddings and chat completions) route through a centralized configuration module (`packages/core/src/config/llm.ts`) that supports any OpenAI-compatible API. A single `OPENROUTER_API_KEY` enables both features, or users can point to Ollama, Together AI, Groq, Azure OpenAI, or any other endpoint via explicit URL/key overrides. Without any LLM keys configured, DeciGraph functions fully — semantic search falls back to PostgreSQL text matching and decisions are recorded manually.

### Pipeline

```
conversation_text (raw)
        │
        ▼
[LLM prompt: extract decisions]
        │
        ▼
[Structured output: ExtractedDecision[]]
   - title, description, reasoning
   - alternatives_considered
   - confidence, tags, affects
   - assumptions, open_questions, dependencies
   - implicit (boolean)
        │
        ▼
[For each extracted decision]
   - Generate embedding
   - Insert to decisions table
   - Run contradiction detection
        │
        ▼
[Optional: generate session summary]
        │
        ▼
DistilleryResult {
  decisions_extracted: number,
  contradictions_found: number,
  decisions: Decision[],
  session_summary?: SessionSummary
}
```

### Contradiction detection

After inserting a new decision, DeciGraph queries for decisions in the same project with high embedding cosine similarity (distance < 0.15 in pgvector cosine space) and different implications. Detected contradictions are inserted into the `contradictions` table with `status = 'unresolved'` and trigger notifications to affected agents.

---

## Layer 5: Temporal Engine

The Temporal Engine manages how decisions age and expire.

### Confidence decay

Each decision has a `confidence_decay_rate` (float, default 0.0). This rate modifies the freshness decay:

```
effective_freshness = max(0, 1 - age_days × (1/365 + confidence_decay_rate))
```

For example, a decision with `confidence_decay_rate = 0.01` decays roughly twice as fast as the default. Use this for volatile decisions like "current API rate limit" or "temporary workaround".

### Supersession chains

When decision B supersedes decision A:
1. A new `Decision` record is created (B).
2. A's `status` is set to `superseded`.
3. A `supersedes` edge is created: B → A.
4. B's `supersedes_id` is set to A's ID.

The `getSupersessionChain(id)` function follows `supersedes_id` links recursively to reconstruct the full history of a decision.

### Temporal flags in compiled context

The Context Compiler surfaces temporal signals inline in the formatted Markdown output:

- `⚠️ Open questions: <question text>` — for decisions with unresolved open questions
- `🔷 Assumptions: <assumption text>` — for decisions that rely on unvalidated assumptions

---

## Role Templates

DeciGraph ships 16 built-in role templates. Each template defines a `RelevanceProfile`:

```typescript
interface RelevanceProfile {
  weights: Record<string, number>;    // tag → relevance weight [0..1]
  decision_depth: number;             // BFS depth for graph expansion
  freshness_preference: 'recent_first' | 'validated_first' | 'balanced';
  include_superseded: boolean;        // whether to include superseded decisions
}
```

### Built-in roles

| Role | Key Tags (weight) | Depth | Freshness | Superseded |
|---|---|---|---|---|
| `architect` | architecture(1.0), api(0.9), database(0.8), perf(0.8) | 3 | balanced | ✓ |
| `builder` | implementation(1.0), architecture(0.9), api(0.9) | 3 | recent_first | ✗ |
| `reviewer` | testing(0.9), architecture(0.9), security(0.8) | 2 | validated_first | ✓ |
| `product` | product(1.0), design(0.8), launch(0.7) | 1 | balanced | ✗ |
| `ops` | infrastructure(1.0), performance(0.9), security(0.8) | 2 | validated_first | ✗ |
| `devops` | infrastructure(1.0), performance(0.8), security(0.7) | 2 | validated_first | ✗ |
| `security` | security(1.0), api(0.8), architecture(0.7), database(0.7) | 3 | validated_first | ✓ |
| `qa` | testing(1.0), api(0.8), performance(0.7) | 2 | recent_first | ✗ |
| `docs` | documentation(1.0), api(0.9), architecture(0.7) | 2 | balanced | ✓ |
| `design` | design(1.0), product(0.8), launch(0.5) | 1 | recent_first | ✗ |
| `analytics` | analytics(1.0), database(0.8), product(0.7) | 1 | recent_first | ✗ |
| `launch` | launch(1.0), product(0.8), documentation(0.7) | 1 | recent_first | ✗ |
| `gtm` | launch(0.9), product(0.9), analytics(0.7) | 1 | recent_first | ✗ |
| `governor` | product(0.8), architecture(0.7), analytics(0.5) | 2 | recent_first | ✗ |
| `blockchain` | blockchain(1.0), security(0.9), architecture(0.8) | 3 | validated_first | ✗ |
| `challenge` | architecture(0.9), security(0.9), testing(0.9) | 3 | balanced | ✓ |

### Custom profiles

Override any field when creating an agent:

```json
{
  "name": "custom-agent",
  "role": "architect",
  "relevance_profile": {
    "weights": {
      "architecture": 1.0,
      "api": 0.9,
      "payments": 1.0,
      "compliance": 0.95
    },
    "decision_depth": 4,
    "freshness_preference": "validated_first",
    "include_superseded": true
  }
}
```

---

## Embedding and Vector Search

### Embedding model

DeciGraph uses OpenAI's `text-embedding-3-small` (1536 dimensions). The embedding text for a decision is built as:

```
{title} {description} {reasoning} {tags.join(" ")} {affects.join(" ")}
```

Embeddings are regenerated automatically when `title`, `description`, `reasoning`, `tags`, or `affects` are updated.

### HNSW index

```sql
CREATE INDEX idx_decisions_embedding ON decisions
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

This creates a Hierarchical Navigable Small World index optimized for cosine similarity queries. The `<=>` operator returns cosine distance (1 - cosine_similarity), so lower is more similar.

### Semantic search endpoint

```sql
SELECT *, (embedding <=> $1::vector) AS _distance
FROM decisions
WHERE project_id = $2 AND embedding IS NOT NULL
ORDER BY embedding <=> $1::vector
LIMIT $3;
```

The search endpoint accepts a natural-language query string, embeds it, then returns the closest decisions by cosine distance.

---

## Feedback Loop and Weight Evolution

The `relevance_feedback` table records whether each decision included in a compiled context package was actually useful:

```sql
CREATE TABLE relevance_feedback (
  agent_id   UUID NOT NULL,
  decision_id UUID NOT NULL,
  was_useful  BOOLEAN NOT NULL,
  usage_signal TEXT,  -- 'referenced' | 'ignored' | 'contradicted' | 'built_upon'
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
```

Agents submit feedback via the `POST /api/feedback` endpoint (or `decigraph_feedback` MCP tool). The `Relevance Learner` module aggregates feedback per (agent_role, tag) pair and can adjust tag weights in the agent's relevance profile:

```
new_weight[tag] = old_weight[tag] × (1 - learning_rate)
               + useful_rate[tag] × learning_rate
```

Where `useful_rate[tag]` is the fraction of decisions with that tag that received positive feedback (`was_useful = true`). The default learning rate is 0.1. Weight updates are applied lazily on the next compile request.

---

## Data Flow Summary

```
Agent submits task description
        ↓
DeciGraph embeds task with text-embedding-3-small
        ↓
Fetch all project decisions
        ↓
Score each with 5-signal algorithm
        ↓
BFS expand from top decisions through graph edges
        ↓
Pack top-scored items into token budget
        ↓
Format as Markdown + JSON
        ↓
Cache result (SHA-256, 1h TTL)
        ↓
Return ContextPackage to agent
        ↓
Agent completes task
        ↓
Agent records decisions + feedback
        ↓
Change Propagator fans out notifications
        ↓
Cache entries for affected agents invalidated
        ↓
Relevance Learner adjusts tag weights
```
