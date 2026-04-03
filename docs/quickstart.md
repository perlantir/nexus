# Quickstart

This guide walks you from zero to a working Nexus setup with your first decisions recorded and an MCP server running in Claude Desktop.

**Time to complete:** ~15 minutes.

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | 22+ | `node --version` |
| pnpm | 9+ | `npm install -g pnpm` |
| Docker + Docker Compose | 24+ | for PostgreSQL |
| OpenAI API key | — | for embeddings (`text-embedding-3-small`) |
| Anthropic API key (optional) | — | for the Distillery LLM pipeline |

If you prefer OpenAI for the Distillery instead of Anthropic, that works too — set `DISTILLERY_PROVIDER=openai` in `.env`.

---

## Step 1 — Clone and Install

```bash
git clone https://github.com/perlantir/nexus.git
cd nexus
pnpm install
```

This installs all workspace packages: `core`, `server`, `sdk`, `mcp`, `cli`, and `dashboard`.

---

## Step 2 — Configure Environment

```bash
cp .env.example .env
```

Open `.env` and fill in the required values:

```dotenv
# Database
DATABASE_URL=postgresql://nexus:nexus_dev@localhost:5432/nexus

# Embeddings (required for semantic search and scoring)
EMBEDDING_PROVIDER=openai
OPENAI_API_KEY=nx_...

# Distillery LLM (for auto-extracting decisions from conversations)
DISTILLERY_PROVIDER=anthropic
ANTHROPIC_API_KEY=nx_...

# Server
PORT=3100
NEXUS_API_KEY=change-me-in-production

# Dashboard
VITE_API_URL=http://localhost:3100
```

The minimum required key is `OPENAI_API_KEY` for embeddings. The Distillery is disabled gracefully if no LLM key is provided.

---

## Step 3 — Start the Database

```bash
docker compose up -d postgres
```

This starts PostgreSQL 17 with the pgvector extension. The container mounts `supabase/migrations/` into `/docker-entrypoint-initdb.d/` so all three migrations run automatically on first boot:

- `001_initial_schema.sql` — tables, indexes, HNSW vector index
- `002_audit_log.sql` — audit trail
- `003_relevance_feedback.sql` — feedback tables for scoring weight evolution

Verify it's ready:

```bash
docker compose ps          # postgres should show "healthy"
```

---

## Step 4 — Run Migrations (Manual Setup Only)

If you started only the database container and want to run migrations manually instead of relying on the Docker init:

```bash
pnpm --filter @nexus/core run migrate
```

Or apply them directly with `psql`:

```bash
psql $DATABASE_URL -f supabase/migrations/001_initial_schema.sql
psql $DATABASE_URL -f supabase/migrations/002_audit_log.sql
psql $DATABASE_URL -f supabase/migrations/003_relevance_feedback.sql
```

---

## Step 5 — Start the Server

```bash
pnpm --filter @nexus/server run dev
```

The server starts on `http://localhost:3100`. Verify it's running:

```bash
curl http://localhost:3100/api/health
# {"status":"ok","version":"0.1.0","timestamp":"..."}
```

To also start the dashboard in development mode:

```bash
pnpm --filter @nexus/dashboard run dev
# Dashboard available at http://localhost:5173
```

Or start everything at once with Turbo:

```bash
pnpm dev
```

---

## Step 6 — Create Your First Project and Agent

Set your API URL:

```bash
export NEXUS_API_URL=http://localhost:3100
```

Create a project:

```bash
PROJECT=$(curl -s -X POST $NEXUS_API_URL/api/projects \
  -H "Content-Type: application/json" \
  -d '{"name": "my-ai-team", "description": "My first Nexus project"}')

echo $PROJECT | jq .
# {
#   "id": "550e8400-e29b-41d4-a716-446655440000",
#   "name": "my-ai-team",
#   "description": "My first Nexus project",
#   "created_at": "2026-04-03T04:00:00.000Z",
#   ...
# }

export NEXUS_PROJECT_ID=$(echo $PROJECT | jq -r .id)
```

Register an agent. Nexus has 16 built-in role templates (`architect`, `builder`, `reviewer`, `product`, `ops`, `devops`, `qa`, `security`, `docs`, `design`, `analytics`, `launch`, `gtm`, `blockchain`, `challenge`, `governor`). Each template pre-loads a relevance profile:

```bash
curl -s -X POST $NEXUS_API_URL/api/projects/$NEXUS_PROJECT_ID/agents \
  -H "Content-Type: application/json" \
  -d '{
    "name": "alice",
    "role": "architect",
    "context_budget_tokens": 50000
  }' | jq .
```

The `architect` role template sets high weights for `architecture`, `api`, `database`, `performance`, and `security` tags, with a graph traversal depth of 3 and `superseded: true` so Alice sees the full decision history.

---

## Step 7 — Record Your First Decision

```bash
curl -s -X POST $NEXUS_API_URL/api/projects/$NEXUS_PROJECT_ID/decisions \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Use PostgreSQL as primary database",
    "description": "All persistent application state will be stored in PostgreSQL 17 with the pgvector extension enabled.",
    "reasoning": "The team has strong PostgreSQL expertise. pgvector eliminates the need for a separate vector database. JSONB support handles flexible metadata without schema migrations.",
    "made_by": "alice",
    "tags": ["database", "architecture", "infrastructure"],
    "affects": ["builder", "ops", "devops"],
    "confidence": "high",
    "alternatives_considered": [
      {"option": "MongoDB", "rejected_reason": "No built-in vector search; team lacks expertise"},
      {"option": "MySQL", "rejected_reason": "No pgvector equivalent available"}
    ],
    "assumptions": ["Cloud provider offers managed PostgreSQL 17 with pgvector"],
    "open_questions": ["What backup frequency is needed for compliance?"]
  }' | jq '{id: .id, title: .title, status: .status}'
```

The response includes an auto-generated UUID and the embedding is computed in the background using `text-embedding-3-small`.

---

## Step 8 — Compile Context

Ask Nexus to compile context for Alice before she designs the authentication layer:

```bash
curl -s -X POST $NEXUS_API_URL/api/compile \
  -H "Content-Type: application/json" \
  -d '{
    "agent_name": "alice",
    "project_id": "'$NEXUS_PROJECT_ID'",
    "task_description": "Design the user authentication system"
  }' | jq '{
    token_count: .token_count,
    decisions_included: .decisions_included,
    decisions_considered: .decisions_considered,
    compilation_time_ms: .compilation_time_ms
  }'
```

The `formatted_markdown` field contains a ready-to-paste context block. The `formatted_json` field contains the same data in machine-readable form.

To see the full markdown context:

```bash
curl -s -X POST $NEXUS_API_URL/api/compile \
  -H "Content-Type: application/json" \
  -d '{
    "agent_name": "alice",
    "project_id": "'$NEXUS_PROJECT_ID'",
    "task_description": "Design the user authentication system"
  }' | jq -r .formatted_markdown
```

---

## Step 9 — Set Up MCP Server with Claude

### Install MCP dependencies

```bash
pnpm --filter @nexus/mcp run build
```

### Configure Claude Desktop

Find your Claude Desktop config:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

Add the Nexus server:

```json
{
  "mcpServers": {
    "nexus": {
      "command": "node",
      "args": ["/absolute/path/to/nexus/packages/mcp/dist/mcp/src/index.js"],
      "env": {
        "NEXUS_API_URL": "http://localhost:3100",
        "NEXUS_PROJECT_ID": "your-project-uuid-here"
      }
    }
  }
}
```

Restart Claude Desktop. You should see "nexus" in the MCP servers list and 12 new tools available in the tools panel.

### Test it

In Claude, try:

> "Use nexus_compile_context to load context for the task: implement the login endpoint"

Claude will call the tool and read back the compiled context package.

---

## Step 10 — Use the Dashboard

Open `http://localhost:3200` (Docker Compose) or `http://localhost:5173` (dev mode) in your browser.

The dashboard shows:

- **Decision Graph** — an interactive force-directed graph. Click any node to see full decision details. Edges are labelled with their relationship type.
- **Session History** — a chronological timeline of all sessions, searchable by agent name and topic.
- **Contradictions** — a feed of automatically-detected conflicting decisions. Click "Resolve" to mark them as resolved or dismissed.
- **Context Comparison** — pick two agents and a task description to compare what each agent would see.
- **Impact Analysis** — select a decision and see every downstream decision, affected agent, and potential cache invalidation.
- **Notification Feed** — a real-time view of unread notifications for each agent.

---

## Next Steps

| What you want to do | Where to look |
|---|---|
| Understand the scoring algorithm | [docs/architecture.md](architecture.md) |
| See all API endpoints | [docs/api-reference.md](api-reference.md) |
| Use Claude with MCP | [docs/mcp-setup.md](mcp-setup.md) |
| Deploy to production | [docs/self-hosting.md](self-hosting.md) |
| Use with LangChain / LangGraph | [docs/framework-guides/langgraph.md](framework-guides/langgraph.md) |
| Use with CrewAI | [docs/framework-guides/crewai.md](framework-guides/crewai.md) |
| Use with AutoGen | [docs/framework-guides/autogen.md](framework-guides/autogen.md) |
| Use with OpenAI Agents | [docs/framework-guides/openai-agents.md](framework-guides/openai-agents.md) |
