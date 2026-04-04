# MCP Setup Guide

DeciGraph ships a fully compliant [Model Context Protocol](https://modelcontextprotocol.io) server that exposes your decision graph to any MCP-compatible client — Claude Desktop, Cursor, Continue, or any custom host. Once connected, AI assistants can read decisions, compile context, record new decisions, and detect contradictions without you writing a single API call.

---

## Table of Contents

- [How the MCP Server Works](#how-the-mcp-server-works)
- [Prerequisites](#prerequisites)
- [Building the MCP Package](#building-the-mcp-package)
- [Claude Desktop](#claude-desktop)
- [Cursor](#cursor)
- [Continue (VS Code / JetBrains)](#continue-vs-code--jetbrains)
- [Custom MCP Hosts](#custom-mcp-hosts)
- [Available Tools](#available-tools)
- [Available Resources](#available-resources)
- [Environment Variables](#environment-variables)
- [Usage Patterns](#usage-patterns)
- [Troubleshooting](#troubleshooting)

---

## How the MCP Server Works

```
Claude Desktop / Cursor / any MCP host
        │
        │  stdio (JSON-RPC 2.0)
        ▼
  packages/mcp/dist/mcp/src/index.js
        │
        │  HTTP REST
        ▼
  DeciGraph Server  (localhost:3100)
        │
        ▼
  PostgreSQL + pgvector
```

The MCP server is a thin stdio transport layer. It reads environment variables for the DeciGraph URL, project ID, and optional API key, then proxies tool calls and resource reads to the DeciGraph REST API. Your client never talks directly to the database.

---

## Prerequisites

- DeciGraph server running (`pnpm dev` or Docker Compose) at `http://localhost:3100`
- A DeciGraph project created (get the project ID from `GET /api/projects`)
- Node.js ≥ 20 (the MCP server is a compiled JS bundle)

---

## Building the MCP Package

If you are running from source, build the MCP package before configuring any client:

```bash
cd /path/to/decigraph
pnpm install
pnpm --filter @decigraph/mcp build
```

The compiled entrypoint will be at:

```
packages/mcp/dist/mcp/src/index.js
```

Verify the build succeeded:

```bash
node packages/mcp/dist/mcp/src/index.js --help 2>/dev/null || echo "MCP server ready"
```

---

## Claude Desktop

### Configuration File Location

| OS      | Path |
|---------|------|
| macOS   | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux   | `~/.config/Claude/claude_desktop_config.json` |

### Minimal Configuration

Open the config file (create it if it does not exist) and add a `mcpServers` entry:

```json
{
  "mcpServers": {
    "decigraph": {
      "command": "node",
      "args": ["/absolute/path/to/decigraph/packages/mcp/dist/mcp/src/index.js"],
      "env": {
        "DECIGRAPH_API_URL": "http://localhost:3100",
        "DECIGRAPH_PROJECT_ID": "proj_01hx..."
      }
    }
  }
}
```

Replace `/absolute/path/to/decigraph` with the real path to your cloned repository and `proj_01hx...` with your project ID.

### Full Configuration (with API key and agent identity)

```json
{
  "mcpServers": {
    "decigraph": {
      "command": "node",
      "args": ["/absolute/path/to/decigraph/packages/mcp/dist/mcp/src/index.js"],
      "env": {
        "DECIGRAPH_API_URL": "http://localhost:3100",
        "DECIGRAPH_PROJECT_ID": "proj_01hx...",
        "DECIGRAPH_API_KEY": "nx_...",
        "DECIGRAPH_AGENT_ID": "agent_01hx..."
      }
    }
  }
}
```

Setting `DECIGRAPH_AGENT_ID` allows `decigraph_get_notifications` to return notifications targeted at the specific agent identity Claude is operating as.

### Restarting Claude Desktop

After editing the config file, fully quit and relaunch Claude Desktop (the menu bar icon is not enough — use **Quit** from the app menu). The DeciGraph tools should appear in the tool picker within the chat window.

---

## Cursor

### Per-workspace Configuration

Create or edit `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "decigraph": {
      "command": "node",
      "args": ["/absolute/path/to/decigraph/packages/mcp/dist/mcp/src/index.js"],
      "env": {
        "DECIGRAPH_API_URL": "http://localhost:3100",
        "DECIGRAPH_PROJECT_ID": "proj_01hx..."
      }
    }
  }
}
```

### Global Configuration

For a global config that applies to all workspaces, edit the Cursor settings JSON:

```json
{
  "mcp.servers": {
    "decigraph": {
      "command": "node",
      "args": ["/absolute/path/to/decigraph/packages/mcp/dist/mcp/src/index.js"],
      "env": {
        "DECIGRAPH_API_URL": "http://localhost:3100",
        "DECIGRAPH_PROJECT_ID": "proj_01hx..."
      }
    }
  }
}
```

Reload the Cursor window after saving (`Cmd/Ctrl + Shift + P` → `Developer: Reload Window`).

---

## Continue (VS Code / JetBrains)

Edit `~/.continue/config.json`:

```json
{
  "mcpServers": [
    {
      "name": "decigraph",
      "command": "node",
      "args": ["/absolute/path/to/decigraph/packages/mcp/dist/mcp/src/index.js"],
      "env": {
        "DECIGRAPH_API_URL": "http://localhost:3100",
        "DECIGRAPH_PROJECT_ID": "proj_01hx..."
      }
    }
  ]
}
```

---

## Custom MCP Hosts

Any MCP host that supports the stdio transport can connect to DeciGraph. The server reads three environment variables and starts listening on stdin/stdout:

```bash
DECIGRAPH_API_URL=http://localhost:3100 \
DECIGRAPH_PROJECT_ID=proj_01hx... \
node /path/to/decigraph/packages/mcp/dist/mcp/src/index.js
```

For hosts that support HTTP/SSE transport instead of stdio, you can run the server as a daemon and point your client at it. Set `MCP_TRANSPORT=sse` in your environment to enable the SSE transport (check your DeciGraph version for SSE support status).

---

## Available Tools

The DeciGraph MCP server registers 12 tools. Every tool call is forwarded to the DeciGraph REST API and returns a JSON response.

### Context & Compilation

| Tool | Description |
|------|-------------|
| `decigraph_compile_context` | Compile a ranked context package for the current agent and task. Returns compiled text plus relevant decisions, notifications, and session summaries. Call this at the start of every new task. |
| `decigraph_auto_capture` | Analyze a conversation snippet and auto-extract decisions, assumptions, and contradictions via the distillery pipeline. |

### Decision Management

| Tool | Description |
|------|-------------|
| `decigraph_record_decision` | Manually record a single decision with title, description, rationale, tags, affects list, and confidence. |
| `decigraph_search_decisions` | Semantic + keyword search across all decisions in the project. |
| `decigraph_list_decisions` | List all decisions, optionally filtered by status or tag. |
| `decigraph_supersede_decision` | Mark an existing decision as superseded by a new one. |
| `decigraph_get_graph` | Retrieve the decision graph as a list of nodes and weighted edges. |
| `decigraph_get_impact` | Analyze the downstream impact of a specific decision. |

### Analysis & Monitoring

| Tool | Description |
|------|-------------|
| `decigraph_get_contradictions` | Find pairs of decisions that contradict each other. |
| `decigraph_get_notifications` | Fetch unread notifications for the current agent. |
| `decigraph_record_session` | Persist a session summary linking decisions made during the current conversation. |
| `decigraph_feedback` | Submit positive or negative relevance feedback on a context compilation result. |

### Tool Input Schemas

#### `decigraph_compile_context`

```json
{
  "agent_name": "string (required) — name of the agent requesting context",
  "task_description": "string (required) — what the agent is about to do",
  "max_tokens": "number (optional) — token budget, default 8000",
  "include_superseded": "boolean (optional) — include superseded decisions at reduced weight"
}
```

#### `decigraph_record_decision`

```json
{
  "title": "string (required) — short decision title",
  "description": "string (required) — full decision description",
  "rationale": "string (optional) — why this decision was made",
  "tags": ["array of strings (optional)"],
  "affects": ["array of agent names/roles this decision affects (optional)"],
  "confidence": "number 0-1 (optional, default 1.0)",
  "status": "string: active | pending | superseded | reverted (optional)"
}
```

#### `decigraph_auto_capture`

```json
{
  "conversation_text": "string (required) — text to extract decisions from",
  "session_id": "string (optional) — associate with an existing session",
  "agent_name": "string (optional) — attribute decisions to this agent"
}
```

#### `decigraph_search_decisions`

```json
{
  "query": "string (required) — natural language or keyword query",
  "limit": "number (optional, default 10)",
  "include_superseded": "boolean (optional)"
}
```

#### `decigraph_get_impact`

```json
{
  "decision_id": "string (required) — ID of the decision to analyze"
}
```

#### `decigraph_supersede_decision`

```json
{
  "decision_id": "string (required) — ID of the decision to supersede",
  "reason": "string (optional) — reason for superseding",
  "new_decision_id": "string (optional) — ID of the replacement decision"
}
```

#### `decigraph_feedback`

```json
{
  "compile_id": "string (required) — ID from a compile_context response",
  "decision_id": "string (required) — ID of the decision to give feedback on",
  "signal": "string: positive | negative (required)",
  "comment": "string (optional)"
}
```

---

## Available Resources

The MCP server exposes 7 resources that clients can read directly via URI.

| URI | Description |
|-----|-------------|
| `decigraph://decisions` | List of all active decisions in the project |
| `decigraph://decisions/{id}` | Full detail for a specific decision |
| `decigraph://decisions/{id}/graph` | Graph neighborhood for a specific decision |
| `decigraph://contradictions` | All detected contradiction pairs |
| `decigraph://sessions` | Recent session summaries |
| `decigraph://agents` | All registered agents and their profiles |
| `decigraph://project/status` | Project health: decision count, contradiction count, pending notifications |

### Reading Resources in Claude

Ask Claude to read these resources directly:

> "Read `decigraph://project/status` and tell me how healthy this project's decision graph is."

> "Show me the decisions in `decigraph://decisions` that are tagged `security`."

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DECIGRAPH_API_URL` | Yes | Base URL of the DeciGraph REST API (e.g. `http://localhost:3100`) |
| `DECIGRAPH_PROJECT_ID` | Yes | The project all tools operate against |
| `DECIGRAPH_API_KEY` | No | API key for authenticated DeciGraph servers |
| `DECIGRAPH_AGENT_ID` | No | Agent ID for notification lookup via `decigraph_get_notifications` |
| `MCP_TRANSPORT` | No | Transport mode: `stdio` (default) or `sse` |

---

## Usage Patterns

### Pattern 1: Auto-context at Task Start

Configure Claude's system prompt or use a Project Custom Instructions block:

> At the start of every coding task, call `decigraph_compile_context` with your agent name and a description of the task. Reference the returned context throughout the task.

Example prompt injection:

```
Before beginning any implementation task:
1. Call decigraph_compile_context with agent_name="claude" and the task description
2. Review all returned decisions relevant to what you are about to do
3. Do not contradict any active decisions without first using decigraph_get_contradictions to check for conflicts
4. When you make a significant architectural or implementation choice, record it with decigraph_record_decision
```

### Pattern 2: End-of-Session Capture

At the end of a long conversation, use `decigraph_auto_capture` to extract everything:

```
decigraph_auto_capture({
  "conversation_text": "<paste full conversation>",
  "session_id": "sess_abc123"
})
```

This runs the distillery pipeline and extracts structured decisions automatically.

### Pattern 3: Contradiction Check Before Implementation

Before implementing a design that might conflict with existing decisions:

```
decigraph_get_contradictions()
decigraph_search_decisions({ "query": "authentication approach" })
```

If contradictions are found, resolve them with `decigraph_supersede_decision` before proceeding.

### Pattern 4: Project Health Check

Start each week by checking project status:

```
Read decigraph://project/status
decigraph_get_notifications()
decigraph_get_contradictions()
```

---

## Troubleshooting

### "Connection refused" errors

The MCP server cannot reach DeciGraph. Check:

```bash
curl http://localhost:3100/health
```

If that fails, ensure the DeciGraph server is running:

```bash
pnpm dev        # from the decigraph project root
# or
docker compose up
```

### Tools not appearing in Claude Desktop

1. Fully quit Claude Desktop (not just minimize)
2. Verify the config file path and JSON syntax with a JSON linter
3. Ensure the `node` binary is on your system PATH (test: `which node`)
4. Use an absolute path for the `args` entry — relative paths do not work
5. Relaunch Claude Desktop and open a new conversation

### "Project not found" errors

Verify the project ID in `DECIGRAPH_PROJECT_ID`:

```bash
curl http://localhost:3100/api/projects | jq '.[].id'
```

### Permissions issues (macOS)

If Node.js is installed via nvm or homebrew, Claude Desktop may not have access to the same PATH. Use the absolute path to node:

```json
{
  "mcpServers": {
    "decigraph": {
      "command": "/Users/yourname/.nvm/versions/node/v22.0.0/bin/node",
      "args": ["/absolute/path/to/decigraph/packages/mcp/dist/mcp/src/index.js"],
      "env": {
        "DECIGRAPH_API_URL": "http://localhost:3100",
        "DECIGRAPH_PROJECT_ID": "proj_01hx..."
      }
    }
  }
}
```

Find your node path with: `which node`

### Debugging MCP server output

Run the MCP server manually to see its stderr output:

```bash
DECIGRAPH_API_URL=http://localhost:3100 \
DECIGRAPH_PROJECT_ID=proj_01hx... \
node packages/mcp/dist/mcp/src/index.js 2>&1
```

Test it with the MCP inspector:

```bash
npx @modelcontextprotocol/inspector \
  node packages/mcp/dist/mcp/src/index.js
```

Then open `http://localhost:5173` to interactively call tools and read resources.

### Slow tool responses

Context compilation involves an embedding lookup and graph traversal. If responses are slow:

- Check that the PostgreSQL HNSW index is built: `pnpm --filter @decigraph/server db:migrate`
- Verify `DATABASE_POOL_MAX` is adequate (default 10)
- Check `LOG_LEVEL=debug` server logs for slow query timing
