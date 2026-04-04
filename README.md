```
███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗
████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝
██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗
██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║
██║ ╚████║███████╗██╔╝ ██╗╚██████╔╝███████║
╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝
```

# DeciGraph — The shared brain for multi-agent AI teams

## Install

**Try it instantly (no Docker needed):**

```bash
npx @decigraph/cli init my-project
```

**Python:**

```bash
pip install decigraph-memory
decigraph-memory init my-project
```

**Production (Docker + PostgreSQL):**

```bash
curl -fsSL https://raw.githubusercontent.com/perlantir/decigraph/main/install.sh | bash
```

Or clone and run manually — see the [Getting Started Guide](docs/getting-started.md).

[![CI](https://github.com/perlantir/decigraph/actions/workflows/ci.yml/badge.svg)](https://github.com/perlantir/decigraph/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Node 22+](https://img.shields.io/badge/node-22%2B-green)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](https://www.typescriptlang.org/)
[![PostgreSQL 17](https://img.shields.io/badge/postgres-17%20%2B%20pgvector-blue)](https://github.com/pgvector/pgvector)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

Maintained by [Perlantir](https://github.com/perlantir).

DeciGraph is an open-source decision-memory platform that keeps multi-agent AI teams aligned. Agents record what they decide, why they decided it, and what changed — then compile that knowledge into a ranked, token-budgeted context package before every task. No more contradictory agents, no more lost decisions, no more context amnesia.

---

## Getting Started

Deploy DeciGraph in under 10 minutes:

```bash
git clone https://github.com/perlantir/decigraph.git
cd decigraph
cp .env.example .env       # Edit with your API key
docker compose up -d        # That's it
```

See the full [Getting Started Guide](docs/getting-started.md) for step-by-step instructions with verification at each step.

---

## Why DeciGraph?

When you run multiple AI agents on a shared codebase or product, they constantly step on each other:

- **Builder** implements an API endpoint that **Architect** already decided to deprecate.
- **Reviewer** approves code that violates a security decision made two sessions ago.
- A new Claude session starts with no memory of the 200 decisions the team made last week.

DeciGraph solves this with a persistent, searchable decision graph, automatic contradiction detection, a 5-signal relevance scorer, and first-class MCP support so Claude and other LLM clients can read and write the shared brain without any code changes.

---

## Features

### Decision Graph
Every decision is a node. Relationships between decisions (`supersedes`, `requires`, `blocks`, `contradicts`, `enables`, `depends_on`, `refines`, `reverts`) are typed edges. You can traverse the graph, detect cycles, and analyse downstream impact before committing a change.

### 5-Signal Context Compiler
When an agent asks "what do I need to know to do this task?", DeciGraph runs a 5-signal scoring algorithm across every decision in the project:
- **Direct affect** (0.40 weight): Is this agent or role explicitly in the decision's `affects` list?
- **Tag matching** (0.20): Do the decision's tags match the agent's relevance profile?
- **Role relevance** (0.15): How many high-priority tags align with the agent's role?
- **Semantic similarity** (0.25): Cosine similarity between the task embedding and the decision embedding (pgvector).
- **Status penalty**: `active` × 1.0, `superseded` × 0.4 or 0.1, `reverted` × 0.05.

Results are packed into a token budget, cached for 1 hour, and returned as formatted Markdown or JSON.

### Distillery
Feed DeciGraph a raw conversation transcript and an LLM (Anthropic Claude or OpenAI GPT-4o-mini) extracts structured decisions, assumptions, open questions, and a session summary automatically. No manual tagging required.

### Change Propagator
When a decision is updated or superseded, DeciGraph identifies every agent whose `affects` or subscription list includes the changed domain, generates role-specific notification messages, and queues them as unread notifications ready for the next context compile.

### Temporal Engine
Decisions carry a `confidence_decay_rate`. Freshness scores decay over time. The compiler surfaces `⚠️ Open questions` and `🔷 Assumptions` inline so agents know exactly where to validate.

### MCP Server
A zero-config Model Context Protocol server exposes 12 tools and 7 resources. Add two lines to `claude_desktop_config.json` and Claude can record decisions, compile context, and search the graph natively — no code changes to your prompts.

### Dashboard
A React + Tailwind dashboard gives you a live view of the decision graph, session history, contradiction feed, context comparison, and impact analysis. Available at `http://localhost:3200` after `docker compose up`.

### Framework Integrations
Drop-in integrations for LangChain/LangGraph, CrewAI, AutoGen, and OpenAI Agents SDK. One import and your existing agents gain persistent decision memory.

---

## Quick Start

### 1. Clone and configure

```bash
git clone https://github.com/perlantir/decigraph.git
cd decigraph
cp .env.example .env
```

Edit `.env` — add your preferred LLM provider:

```bash
# Pick one:
OPENROUTER_API_KEY=sk-or-your-key    # Recommended: one key, all features
# OPENAI_API_KEY=sk-your-key          # Alternative: OpenAI direct
# ANTHROPIC_API_KEY=sk-ant-your-key   # Alternative: Anthropic direct
# Or leave all blank — DeciGraph works without LLM keys
```

### 2. Start everything with Docker Compose

```bash
docker compose up -d
```

This starts:
- **PostgreSQL 17 + pgvector** on port 5432 (with migrations auto-applied)
- **DeciGraph API server** on port 3100
- **Dashboard** on port 3200

### 3. Create your first project

```bash
export DECIGRAPH_API_URL=http://localhost:3100
curl -s -X POST $DECIGRAPH_API_URL/api/projects \
  -H "Content-Type: application/json" \
  -d '{"name": "my-project", "description": "Testing DeciGraph"}' | jq .id
# → "proj-uuid-here"
export DECIGRAPH_PROJECT_ID="proj-uuid-here"
```

### 4. Register an agent

```bash
curl -s -X POST $DECIGRAPH_API_URL/api/projects/$DECIGRAPH_PROJECT_ID/agents \
  -H "Content-Type: application/json" \
  -d '{"name": "alice", "role": "architect", "context_budget_tokens": 50000}' | jq .
```

### 5. Record a decision

```bash
curl -s -X POST $DECIGRAPH_API_URL/api/projects/$DECIGRAPH_PROJECT_ID/decisions \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Use PostgreSQL as primary database",
    "description": "All persistent state lives in PostgreSQL 17.",
    "reasoning": "Team familiarity, strong JSON support, and pgvector for embeddings.",
    "made_by": "alice",
    "tags": ["database", "architecture"],
    "affects": ["builder", "ops"],
    "confidence": "high"
  }' | jq .id
```

### 6. Compile context before a task

```bash
curl -s -X POST $DECIGRAPH_API_URL/api/compile \
  -H "Content-Type: application/json" \
  -d '{
    "agent_name": "alice",
    "project_id": "'$DECIGRAPH_PROJECT_ID'",
    "task_description": "Design the data layer for user authentication"
  }' | jq .formatted_markdown
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         DeciGraph Platform                          │
│                                                                 │
│   ┌──────────┐   ┌───────────┐   ┌──────────┐   ┌──────────┐  │
│   │  Claude  │   │LangChain/ │   │ CrewAI / │   │  CLI /   │  │
│   │ (via MCP)│   │ LangGraph │   │ AutoGen  │   │ REST API │  │
│   └────┬─────┘   └─────┬─────┘   └────┬─────┘   └────┬─────┘  │
│        │               │              │               │         │
│        └───────────────┴──────────────┴───────────────┘         │
│                                 │                               │
│                    ┌────────────▼────────────┐                  │
│                    │    Hono REST API :3100   │                  │
│                    │  Auth · Audit · CORS     │                  │
│                    └────────────┬────────────┘                  │
│                                 │                               │
│         ┌───────────────────────┼───────────────────────┐       │
│         │                       │                       │       │
│  ┌──────▼──────┐  ┌─────────────▼────────┐  ┌──────────▼─────┐ │
│  │  Decision   │  │  Context Compiler    │  │  Distillery    │ │
│  │   Graph     │  │  5-signal scoring    │  │  LLM extract   │ │
│  │  + Edges    │  │  Token budget pack   │  │  decisions     │ │
│  └──────┬──────┘  │  Cache (1h SHA256)   │  └──────┬─────────┘ │
│         │         └─────────────┬────────┘         │           │
│         │                       │                  │           │
│  ┌──────▼───────────────────────▼──────────────────▼──────┐    │
│  │          Change Propagator · Temporal Engine            │    │
│  │  Contradiction detection · Supersession chains         │    │
│  │  Notification fan-out · Freshness decay                 │    │
│  └──────────────────────────┬──────────────────────────────┘    │
│                             │                                   │
│              ┌──────────────▼──────────────┐                    │
│              │  PostgreSQL 17 + pgvector   │                    │
│              │  HNSW index (cosine ops)    │                    │
│              └─────────────────────────────┘                    │
└─────────────────────────────────────────────────────────────────┘
```

---

## MCP Quickstart (Claude Desktop)

Add DeciGraph to your Claude Desktop configuration:

```json
// ~/Library/Application Support/Claude/claude_desktop_config.json
{
  "mcpServers": {
    "decigraph": {
      "command": "node",
      "args": ["/path/to/decigraph/packages/mcp/dist/mcp/src/index.js"],
      "env": {
        "DECIGRAPH_API_URL": "http://localhost:3100",
        "DECIGRAPH_PROJECT_ID": "your-project-uuid"
      }
    }
  }
}
```

Restart Claude Desktop. You now have 12 tools available:

- `decigraph_compile_context` — load relevant decisions before any task
- `decigraph_record_decision` — record a decision into the graph
- `decigraph_auto_capture` — extract decisions from a conversation automatically
- `decigraph_search_decisions` — semantic search across all decisions
- `decigraph_supersede_decision` — replace an outdated decision
- `decigraph_get_impact` — analyse downstream impact of a change
- `decigraph_get_contradictions` — surface conflicting decisions
- `decigraph_get_graph` — traverse the decision graph
- `decigraph_record_session` — save a session summary
- `decigraph_get_notifications` — read pending alerts
- `decigraph_feedback` — teach DeciGraph which decisions were useful
- `decigraph_list_decisions` — browse decisions with filters

See [docs/mcp-setup.md](docs/mcp-setup.md) for full configuration options and Cursor integration.

---

## Framework Integrations

### LangChain

```python
from decigraph_sdk import DeciGraphClient
from decigraph_langchain import DeciGraphMemory

client = DeciGraphClient(base_url="http://localhost:3100")
memory = DeciGraphMemory(client=client, project_id="proj-id", agent_name="coder")
chain = LLMChain(llm=llm, prompt=prompt, memory=memory)
```

### LangGraph

```python
from decigraph_langchain import DeciGraphCheckpointer

checkpointer = DeciGraphCheckpointer(client=client, project_id="proj-id", agent_name="orchestrator")
app = graph.compile(checkpointer=checkpointer)
result = app.invoke({"messages": [...]}, config={"configurable": {"thread_id": "t1"}})
```

### CrewAI

```python
from decigraph_crewai import DeciGraphCrewMemory, DeciGraphCrewCallback

memory = DeciGraphCrewMemory(client=client, project_id="proj-id", agent_name="researcher")
cb = DeciGraphCrewCallback(client=client, project_id="proj-id")
crew = Crew(agents=[...], tasks=[...], task_callback=cb.on_task_complete)
```

### AutoGen

```python
from decigraph_autogen import DeciGraphAutoGenMemory

mem = DeciGraphAutoGenMemory(client=client, project_id="proj-id", agent_name="assistant")
system_ctx = mem.get_context()
assistant = autogen.AssistantAgent(name="assistant",
    system_message=f"{system_ctx}\n\nYou are a helpful assistant.")
```

### OpenAI Agents SDK

```python
from decigraph_openai_agents import DeciGraphAgentHooks

hooks = DeciGraphAgentHooks(client=client, project_id="proj-id", agent_name="assistant")
agent = Agent(name="assistant", instructions="You are helpful.", hooks=hooks)
result = await Runner.run(agent, "Help me design the API.")
```

---

## Python SDK

```python
from decigraph_sdk import DeciGraphClient

client = DeciGraphClient(base_url="http://localhost:3100", api_key="nx_...")

# Create a project
project = client.create_project("My Project")

# Record a decision
decision = client.create_decision(
    project_id=project["id"],
    title="Use Redis for session cache",
    description="Session data will be stored in Redis with a 24h TTL.",
    reasoning="Latency requirements rule out database round-trips for auth checks.",
    made_by="architect-agent",
    tags=["architecture", "performance", "security"],
)

# Compile context before a task
ctx = client.compile_context(
    project_id=project["id"],
    agent_name="builder",
    task_description="Implement the user login endpoint",
)
print(ctx["formatted_markdown"])

# Distil decisions from a conversation
result = client.distill(
    project_id=project["id"],
    conversation_text=open("session.txt").read(),
    agent_name="builder",
)
print(f"Extracted {result['decisions_extracted']} decisions")
```

---

## TypeScript SDK

```typescript
import { DeciGraphClient } from '@decigraph/sdk';

const client = new DeciGraphClient({ baseUrl: 'http://localhost:3100' });

// Create a project and register an agent
const project = await client.createProject({ name: 'My Project' });
const agent = await client.createAgent(project.id, {
  name: 'alice',
  role: 'architect',
  context_budget_tokens: 50000,
});

// Record a decision
const decision = await client.createDecision(project.id, {
  title: 'Use Hono as HTTP framework',
  description: 'The REST API is built with Hono for edge compatibility.',
  reasoning: 'Hono is 3x faster than Express and runs on Cloudflare Workers.',
  made_by: 'alice',
  tags: ['architecture', 'api'],
  affects: ['builder', 'ops'],
  confidence: 'high',
});

// Compile context
const ctx = await client.compileContext({
  agent_name: 'alice',
  project_id: project.id,
  task_description: 'Add rate limiting to the API',
});
console.log(ctx.formatted_markdown);
```

---

## CLI Usage

```bash
# Install globally
npm install -g @decigraph/cli

# Set environment
export DECIGRAPH_API_URL=http://localhost:3100
export DECIGRAPH_PROJECT_ID=your-project-id

# Create a project
decigraph init "My Project" --description "Production AI team"

# List decisions
decigraph decisions list --status active --tags architecture

# Add a decision interactively
decigraph decisions add

# Semantic search
decigraph decisions search "authentication approach"

# View decision graph as ASCII tree
decigraph decisions graph <decision-id> --depth 3

# Analyse downstream impact
decigraph decisions impact <decision-id>

# Supersede a decision
decigraph decisions supersede <old-decision-id>

# Compile context for an agent
decigraph compile alice "Implement the payments module" --markdown

# Distil decisions from a conversation file
decigraph distill ./session.txt --agent alice --session

# View project stats
decigraph status

# Check for contradictions
decigraph contradictions

# Show agent notifications
decigraph notifications --agent <agent-id>
```

---

## Dashboard

Open [http://localhost:3200](http://localhost:3200) after `docker compose up` to access:

- **Decision Graph** — force-directed visualization of the decision graph with edge labels
- **Session History** — timeline of all agent sessions with linked decisions
- **Contradictions** — unresolved conflicts between decisions with resolution workflow
- **Context Comparison** — side-by-side view of what different agents see for the same task
- **Impact Analysis** — downstream effect visualizer for any decision
- **Notifications Feed** — real-time feed of changes affecting each agent

---

## Self-Hosting

See [docs/self-hosting.md](docs/self-hosting.md) for complete setup instructions including:
- Docker Compose (recommended)
- Manual setup with `pnpm`
- PostgreSQL 17 + pgvector installation
- Nginx reverse proxy configuration
- SSL/TLS setup
- Backup and restore procedures
- Monitoring with health endpoints

---

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

### Development Setup

```bash
git clone https://github.com/perlantir/decigraph.git
cd decigraph
pnpm install
cp .env.example .env
# Fill in API keys
docker compose up -d postgres   # start only the database
pnpm dev                        # start server in watch mode
```

### Package Structure

```
decigraph/
├── packages/
│   ├── core/        TypeScript core library (scoring, context compiler, roles)
│   ├── server/      Hono REST API server
│   ├── sdk/         TypeScript client SDK
│   ├── mcp/         Model Context Protocol server
│   ├── cli/         Command-line interface
│   └── dashboard/   React + Tailwind web dashboard
├── integrations/
│   ├── langchain/   LangChain / LangGraph integration
│   ├── crewai/      CrewAI integration
│   ├── autogen/     Microsoft AutoGen integration
│   └── openai-agents/ OpenAI Agents SDK integration
├── python-sdk/      Python client SDK
└── supabase/
    └── migrations/  PostgreSQL schema migrations
```

### Running Tests

```bash
pnpm test                # run all tests
pnpm test --filter core  # run core package tests only
```

---

## Documentation

| Document | Description |
|---|---|
| [docs/quickstart.md](docs/quickstart.md) | Step-by-step getting started guide |
| [docs/architecture.md](docs/architecture.md) | Deep dive into the 5 core layers |
| [docs/api-reference.md](docs/api-reference.md) | Complete REST API reference |
| [docs/mcp-setup.md](docs/mcp-setup.md) | MCP server setup for Claude and Cursor |
| [docs/self-hosting.md](docs/self-hosting.md) | Production deployment guide |
| [docs/framework-guides/langgraph.md](docs/framework-guides/langgraph.md) | LangChain / LangGraph integration |
| [docs/framework-guides/crewai.md](docs/framework-guides/crewai.md) | CrewAI integration |
| [docs/framework-guides/autogen.md](docs/framework-guides/autogen.md) | Microsoft AutoGen integration |
| [docs/framework-guides/openai-agents.md](docs/framework-guides/openai-agents.md) | OpenAI Agents SDK integration |

---

## License

Apache License 2.0 — see [LICENSE](LICENSE) for full text.

You are free to use, modify, and distribute DeciGraph in commercial projects. Attribution is appreciated but not required.
