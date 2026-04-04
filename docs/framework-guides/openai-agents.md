# OpenAI Agents SDK Integration Guide

The `decigraph-openai-agents` package integrates DeciGraph decision memory into the [OpenAI Agents SDK](https://github.com/openai/openai-agents-python) via the `AgentHooks` protocol. It provides `DeciGraphAgentHooks`, which automatically injects compiled DeciGraph context into agent instructions at run start, captures all tool outputs and LLM responses for decision extraction, handles handoffs between agents, and creates session summaries when each run finishes.

---

## Table of Contents

- [How It Works](#how-it-works)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [DeciGraphAgentHooks Reference](#decigraphagenthooks-reference)
  - [Constructor Parameters](#constructor-parameters)
  - [`on_start`](#on_start)
  - [`on_end`](#on_end)
  - [`on_tool_call`](#on_tool_call)
  - [`on_tool_output`](#on_tool_output)
  - [`on_handoff`](#on_handoff)
  - [`flush()`](#flush)
- [Complete Example: Single Agent](#complete-example-single-agent)
- [Complete Example: Multi-Agent Handoffs](#complete-example-multi-agent-handoffs)
- [Complete Example: Agent with Tools](#complete-example-agent-with-tools)
- [Complete Example: Long-Running Agent Loop](#complete-example-long-running-agent-loop)
- [Accessing Compiled Context Directly](#accessing-compiled-context-directly)
- [Recording Decisions Manually](#recording-decisions-manually)
- [Configuration Reference](#configuration-reference)
- [Best Practices](#best-practices)
- [Troubleshooting](#troubleshooting)

---

## How It Works

```
Runner.run(agent, "Help me design the API.")
    │
    ▼
DeciGraphAgentHooks.on_start(context, agent)
    ├── compile_context(agent_name, task_description + input)
    ├── Prepend [DeciGraph Context] to run_context.run_instructions
    └── Add user input to _run_buffer

    (Agent runs, calls tools)
    │
    ▼
DeciGraphAgentHooks.on_tool_output(context, agent, tool, result)
    └── Append "[Tool: {name}]\n{result}" to _run_buffer

    (Agent generates final response)
    │
    ▼
DeciGraphAgentHooks.on_end(context, agent, output)
    ├── Append "Assistant: {output}" to _run_buffer
    ├── _flush_buffer() → distillery → extracts decisions
    └── _create_session_summary() → links decisions
```

The hooks inject context into `run_context.run_instructions` — the SDK's mechanism for dynamic instructions that override or augment the agent's static `instructions` field. The context injection is non-destructive: it prepends the DeciGraph block, leaving the agent's existing instructions intact.

---

## Installation

```bash
pip install decigraph-sdk decigraph-openai-agents openai-agents
```

Or install from the repository:

```bash
cd /path/to/decigraph/integrations/openai-agents
pip install -e .
```

**Supported versions:**
- Python 3.10+
- openai-agents ≥ 0.0.3
- decigraph-sdk 0.1+

---

## Quick Start

```python
import asyncio
import os
from agents import Agent, Runner
from decigraph_sdk import DeciGraphClient
from decigraph_openai_agents import DeciGraphAgentHooks

# Initialize
client = DeciGraphClient(base_url=os.environ["DECIGRAPH_API_URL"])

# Create hooks — attach these to any Agent
hooks = DeciGraphAgentHooks(
    client=client,
    project_id=os.environ["DECIGRAPH_PROJECT_ID"],
    agent_name="assistant",
    task_description="Help design and implement the payments service.",
)

# Create an agent with DeciGraph hooks
agent = Agent(
    name="assistant",
    instructions="You are a helpful software engineer specializing in payment systems.",
    hooks=hooks,
)

async def main():
    result = await Runner.run(
        agent,
        "What approach should we use for handling payment idempotency?",
    )
    print(result.final_output)

asyncio.run(main())
```

On `on_start`, DeciGraph compiles all relevant decisions for `"assistant"` and the given task. The compiled context is prepended to `run_instructions` so the agent sees it alongside its static instructions. On `on_end`, the conversation is sent to the distillery for decision extraction.

---

## DeciGraphAgentHooks Reference

### Constructor Parameters

```python
DeciGraphAgentHooks(
    client: DeciGraphClient,
    project_id: str,
    agent_name: str,
    task_description: str = "Perform the current task.",
    max_tokens: int | None = None,
    inject_context_into_instructions: bool = True,
    capture_tool_outputs: bool = True,
    create_session_on_end: bool = True,
)
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `client` | `DeciGraphClient` | required | Initialized DeciGraph client |
| `project_id` | `str` | required | DeciGraph project ID |
| `agent_name` | `str` | required | Agent name for context scoping and attribution |
| `task_description` | `str` | `"Perform the current task."` | Baseline task description; appended with run input |
| `max_tokens` | `int \| None` | `None` | Token budget for context compilation |
| `inject_context_into_instructions` | `bool` | `True` | Prepend DeciGraph context to `run_context.run_instructions` on start |
| `capture_tool_outputs` | `bool` | `True` | Include tool call results in the distillery buffer |
| `create_session_on_end` | `bool` | `True` | Create a `SessionSummary` in DeciGraph on run end |

### `on_start`

Called by the SDK when a new agent run begins.

Behavior:
1. Resets the run buffer and session start time
2. Extracts the run input and adds it to the buffer
3. Calls `compile_context` with `task_description + "\n\nCurrent input: " + input`
4. If `inject_context_into_instructions=True`, prepends `[DeciGraph Context]\n{text}\n\n` to `run_context.run_instructions`
5. If context injection is disabled, logs a debug message instead

The injection is idempotent — if the DeciGraph block is already in `run_instructions`, it is not duplicated.

### `on_end`

Called by the SDK when the agent run finishes.

Behavior:
1. Extracts `output` text and appends `"Assistant: {text}"` to the buffer
2. Calls `_flush_buffer()` → sends the accumulated buffer to the distillery
3. If `create_session_on_end=True`, calls `_create_session_summary()` → creates a DeciGraph `SessionSummary` linking all extracted decisions
4. Resets internal state for the next run

### `on_tool_call`

Called before a tool is invoked. Currently a no-op — subclass to add pre-call logging:

```python
class MyHooks(DeciGraphAgentHooks):
    async def on_tool_call(self, context, agent, tool):
        tool_name = getattr(tool, "name", str(tool))
        print(f"[{agent.name}] Calling tool: {tool_name}")
        await super().on_tool_call(context, agent, tool)
```

### `on_tool_output`

Called after a tool returns a result. When `capture_tool_outputs=True`:
- Extracts the result as text
- Appends `"[Tool: {name}]\n{result}"` to the run buffer
- This output will be distilled alongside the LLM conversation on `on_end`

### `on_handoff`

Called when control is handed off to this agent from another. Logs the handoff source at DEBUG level. Override to refresh context on handoff:

```python
class MyHooks(DeciGraphAgentHooks):
    async def on_handoff(self, context, agent, source):
        source_name = getattr(source, "name", str(source))
        print(f"Handoff: {source_name} → {agent.name}")
        # Re-compile context for the new role
        await super().on_handoff(context, agent, source)
```

### `flush()`

Manually flush the current run buffer to the distillery. Useful for long-running agents where you want intermediate checkpoints:

```python
# In a loop
for iteration in range(10):
    result = await Runner.run(agent, f"Step {iteration}: ...")
    if iteration % 3 == 0:
        await hooks.flush()  # intermediate checkpoint
```

---

## Complete Example: Single Agent

```python
import asyncio
import os
from agents import Agent, Runner
from decigraph_sdk import DeciGraphClient
from decigraph_openai_agents import DeciGraphAgentHooks

client = DeciGraphClient(
    base_url=os.environ["DECIGRAPH_API_URL"],
    api_key=os.environ.get("DECIGRAPH_API_KEY"),
)
PROJECT_ID = os.environ["DECIGRAPH_PROJECT_ID"]

hooks = DeciGraphAgentHooks(
    client=client,
    project_id=PROJECT_ID,
    agent_name="architect",
    task_description="Design the authentication system for the DeciGraph API.",
    max_tokens=6000,
    inject_context_into_instructions=True,
    capture_tool_outputs=True,
    create_session_on_end=True,
)

agent = Agent(
    name="architect",
    instructions=(
        "You are a software architect. When proposing design decisions, "
        "always include:\n"
        "1. What you decided\n"
        "2. Why (rationale)\n"
        "3. Alternatives rejected\n"
        "4. Affected components\n\n"
        "State conclusions clearly so they can be extracted as decisions."
    ),
    hooks=hooks,
    model="gpt-4o",
)

async def run_architecture_session():
    questions = [
        "Should we use JWT or API keys for authentication? Consider mobile and server-to-server clients.",
        "What should the token expiry policy be?",
        "How should refresh tokens be stored securely?",
    ]

    for question in questions:
        print(f"\n{'='*60}")
        print(f"Q: {question}")
        print('='*60)
        result = await Runner.run(agent, question)
        print(f"A: {result.final_output}")

    print("\nAll decisions captured in DeciGraph.")

asyncio.run(run_architecture_session())
```

---

## Complete Example: Multi-Agent Handoffs

The OpenAI Agents SDK supports agent-to-agent handoffs. `DeciGraphAgentHooks.on_handoff` is called when the receiving agent gets control.

```python
import asyncio
import os
from agents import Agent, Runner, handoff
from decigraph_sdk import DeciGraphClient
from decigraph_openai_agents import DeciGraphAgentHooks

client = DeciGraphClient(base_url=os.environ["DECIGRAPH_API_URL"])
PROJECT_ID = os.environ["DECIGRAPH_PROJECT_ID"]

def make_hooks(role: str, task: str) -> DeciGraphAgentHooks:
    return DeciGraphAgentHooks(
        client=client,
        project_id=PROJECT_ID,
        agent_name=role,
        task_description=task,
        max_tokens=4096,
        create_session_on_end=True,
    )

# Security specialist — receives handoffs from the architect
security_agent = Agent(
    name="security",
    instructions=(
        "You are a security engineer. Review architectural proposals for:\n"
        "1. OWASP API Security Top 10 compliance\n"
        "2. Data exposure risks\n"
        "3. Authentication/authorization gaps\n"
        "4. Rate limiting and DoS prevention\n\n"
        "Return a structured security review with risk ratings (Critical/High/Medium/Low)."
    ),
    hooks=make_hooks("security", "Review architectural decisions for security risks."),
    model="gpt-4o",
)

# Architecture agent — can hand off to security for review
architect_agent = Agent(
    name="architect",
    instructions=(
        "You are a software architect. Design solutions and, when your proposal "
        "involves security-sensitive components (auth, payments, data access), "
        "hand off to the security agent for review."
    ),
    hooks=make_hooks("architect", "Design system architecture with security review."),
    model="gpt-4o",
    handoffs=[handoff(security_agent)],
)

async def run_design_with_review():
    result = await Runner.run(
        architect_agent,
        (
            "Design the user authentication flow for our API. "
            "Include token issuance, validation, and revocation. "
            "Make sure the security team reviews your proposal."
        ),
    )
    print(result.final_output)

asyncio.run(run_design_with_review())
```

When the architect hands off to security, the security agent's `on_start` fires:
1. DeciGraph compiles context scoped to the `"security"` role (decisions tagged with `security`, high-priority security role tags)
2. The security context is injected into the security agent's instructions
3. The security agent's output is buffered and distilled on `on_end`
4. Two separate `SessionSummary` records are created — one per agent

---

## Complete Example: Agent with Tools

```python
import asyncio
import os
from agents import Agent, Runner, function_tool
from decigraph_sdk import DeciGraphClient
from decigraph_openai_agents import DeciGraphAgentHooks

client = DeciGraphClient(base_url=os.environ["DECIGRAPH_API_URL"])
PROJECT_ID = os.environ["DECIGRAPH_PROJECT_ID"]

@function_tool
def search_codebase(query: str) -> str:
    """Search the codebase for relevant code patterns."""
    # In production, connect to your actual code search
    return f"Search results for '{query}': [found 3 matching files]"

@function_tool
def run_security_scan(component: str) -> str:
    """Run a security scan on the specified component."""
    return f"Security scan for '{component}': No critical vulnerabilities found. 2 medium warnings."

@function_tool
def check_existing_decisions(topic: str) -> str:
    """Check if decisions related to this topic already exist in DeciGraph."""
    # Call the DeciGraph API directly
    import requests
    resp = requests.get(
        f"{os.environ['DECIGRAPH_API_URL']}/api/projects/{PROJECT_ID}/decisions/search",
        params={"query": topic, "limit": 5},
    )
    if resp.ok:
        decisions = resp.json()
        if not decisions:
            return f"No existing decisions found for '{topic}'."
        lines = [f"Found {len(decisions)} existing decisions:"]
        for d in decisions:
            lines.append(f"  [{d['status']}] {d['title']}")
        return "\n".join(lines)
    return "Could not query DeciGraph for existing decisions."

hooks = DeciGraphAgentHooks(
    client=client,
    project_id=PROJECT_ID,
    agent_name="security-reviewer",
    task_description="Review codebase components for security vulnerabilities and record findings.",
    max_tokens=8000,
    capture_tool_outputs=True,
)

agent = Agent(
    name="security-reviewer",
    instructions=(
        "You are a security engineer. Use your tools to:\n"
        "1. Check existing security decisions (check_existing_decisions)\n"
        "2. Search the codebase for relevant patterns (search_codebase)\n"
        "3. Run security scans on components (run_security_scan)\n\n"
        "When you identify a security requirement, state it as a clear decision "
        "with title, description, and rationale."
    ),
    tools=[search_codebase, run_security_scan, check_existing_decisions],
    hooks=hooks,
    model="gpt-4o",
)

async def run_security_review():
    result = await Runner.run(
        agent,
        "Perform a security review of the authentication and session management components.",
    )
    print(result.final_output)
    print("\nSecurity decisions extracted and stored in DeciGraph.")

asyncio.run(run_security_review())
```

---

## Complete Example: Long-Running Agent Loop

For scenarios where the same agent runs many times in a loop, use `flush()` for intermediate checkpoints:

```python
import asyncio
import os
from agents import Agent, Runner
from decigraph_sdk import DeciGraphClient
from decigraph_openai_agents import DeciGraphAgentHooks

client = DeciGraphClient(base_url=os.environ["DECIGRAPH_API_URL"])
PROJECT_ID = os.environ["DECIGRAPH_PROJECT_ID"]

hooks = DeciGraphAgentHooks(
    client=client,
    project_id=PROJECT_ID,
    agent_name="code-reviewer",
    task_description="Review pull requests and record architectural decisions.",
    capture_tool_outputs=True,
    create_session_on_end=False,  # We manage sessions manually
)

agent = Agent(
    name="code-reviewer",
    instructions="You are a code reviewer. Review the provided code and identify key decisions.",
    hooks=hooks,
    model="gpt-4o-mini",
)

# Simulate a queue of pull requests
pull_requests = [
    ("PR-101", "Add JWT authentication middleware"),
    ("PR-102", "Refactor database connection pooling"),
    ("PR-103", "Implement rate limiting"),
    ("PR-104", "Add Redis cache layer"),
    ("PR-105", "Update API versioning strategy"),
]

async def review_all_prs():
    for pr_id, pr_title in pull_requests:
        print(f"\nReviewing {pr_id}: {pr_title}")

        result = await Runner.run(
            agent,
            f"Review {pr_id}: '{pr_title}'. Identify any architectural decisions made.",
        )
        print(f"Review: {result.final_output[:200]}...")

    # Flush all accumulated captures to the distillery in one batch
    await hooks.flush()

    # Create a single session summary for the entire review batch
    from decigraph_sdk import DeciGraphClient
    session = client.create_session_summary(
        project_id=PROJECT_ID,
        agent_name="code-reviewer",
        summary=f"Batch PR review session: reviewed {len(pull_requests)} PRs",
        metadata={"pr_count": len(pull_requests), "framework": "openai-agents"},
    )
    print(f"\nSession summary created: {session['id']}")

asyncio.run(review_all_prs())
```

---

## Accessing Compiled Context Directly

If you need the compiled DeciGraph context before creating an agent (e.g., for conditional logic), access the DeciGraph client directly:

```python
from decigraph_sdk import DeciGraphClient

client = DeciGraphClient(base_url="http://localhost:3100")

context_package = client.compile_context(
    project_id="proj_01hx...",
    agent_name="architect",
    task_description="Design the new authentication system.",
    max_tokens=6000,
)

# Full compiled text (formatted for injection)
print(context_package["compiled_text"])

# Individual decisions with scores
for decision in context_package["relevant_decisions"]:
    print(f"[score={decision['score']:.2f}] {decision['title']}")

# Unread notifications for this agent
for notif in context_package.get("notifications", []):
    print(f"[NOTIFICATION] {notif['message']}")

# Active contradictions
for contra in context_package.get("contradictions", []):
    print(f"[CONTRADICTION] {contra['decision_a']['title']} ↔ {contra['decision_b']['title']}")
```

Then inject it manually if needed:

```python
from agents import Agent

agent = Agent(
    name="architect",
    instructions=f"""[DeciGraph Context]
{context_package['compiled_text']}

You are a software architect...""",
    model="gpt-4o",
)
```

---

## Recording Decisions Manually

For high-confidence decisions made outside of conversation, record them directly:

```python
from decigraph_sdk import DeciGraphClient

client = DeciGraphClient(base_url="http://localhost:3100")

decision = client.record_decision(
    project_id="proj_01hx...",
    title="Use gpt-4o-mini for code review agents",
    description=(
        "All code review agents use gpt-4o-mini to optimize cost. "
        "Architecture and security review agents continue to use gpt-4o."
    ),
    rationale=(
        "Code review tasks are well-structured and do not require frontier reasoning. "
        "gpt-4o-mini reduces cost by 15× with acceptable quality for this task type."
    ),
    tags=["ai", "cost", "agents"],
    affects=["architect", "devops", "ops"],
    confidence=0.90,
)

print(f"Decision: {decision['id']}")
```

---

## Configuration Reference

### DeciGraphClient

```python
DeciGraphClient(
    base_url="http://localhost:3100",
    api_key="nxk_...",   # optional
    timeout=30,
)
```

### Environment Variables

```bash
DECIGRAPH_API_URL=http://localhost:3100
DECIGRAPH_PROJECT_ID=proj_01hx...
DECIGRAPH_API_KEY=nxk_...
```

### OpenAI Agents SDK Environment Variables

```bash
OPENAI_API_KEY=sk-...
```

---

## Best Practices

**Create one `DeciGraphAgentHooks` instance per agent.** Each instance tracks its own run buffer and session start time. Sharing hooks across agents will conflate their decision histories.

**Use `agent_name` values that match DeciGraph role templates.** Names like `"architect"`, `"security"`, `"reviewer"`, `"qa"` activate the built-in role templates and improve context relevance through signal C (role relevance) weighting.

**Set `task_description` to match the agent's actual task.** This is combined with the run input for context compilation. The better it describes the agent's domain, the higher the quality of retrieved context.

**For multi-agent pipelines, give each agent distinct hooks.** Even if multiple agents share the same `project_id`, they should have separate `DeciGraphAgentHooks` instances with their own `agent_name` and `task_description`.

**Set `create_session_on_end=False` for tight loops.** If an agent runs hundreds of times (e.g., processing a queue), avoid creating hundreds of session summaries. Instead, set `create_session_on_end=False`, call `flush()` periodically, and create a single summary at the end.

**Subclass for custom behavior.** The `AgentHooks` protocol is designed for subclassing. Override `on_handoff` to refresh context, `on_tool_call` to log pre-call, or `on_end` to post-process output before distillation:

```python
class MyProductionHooks(DeciGraphAgentHooks):
    async def on_end(self, context, agent, output):
        # Custom pre-processing
        output_text = str(output)
        if len(output_text) > 50000:
            # Truncate very long outputs before distillation
            output_text = output_text[:50000] + "... [truncated]"
        # Call parent with original output (buffer is populated inside)
        await super().on_end(context, agent, output)
```

---

## Troubleshooting

### Context not appearing in agent instructions

Verify `inject_context_into_instructions=True` (the default) and that the DeciGraph project has decisions:

```bash
curl http://localhost:3100/api/projects/proj_01hx.../decisions | jq length
```

Check if the SDK exposes `run_context.run_instructions` as a mutable attribute — some versions of `openai-agents` use read-only run context:

```python
# If injection silently fails, use manual injection instead:
hooks = DeciGraphAgentHooks(
    ...,
    inject_context_into_instructions=False,  # disable automatic injection
)

# And manually prepend context:
context = client.compile_context(project_id=PROJECT_ID, agent_name="agent", task_description="...")
agent = Agent(
    instructions=f"[DeciGraph Context]\n{context['compiled_text']}\n\nYou are...",
    hooks=hooks,  # still captures outputs for distillation
)
```

### `on_end` not called / session summary missing

Ensure you use `Runner.run()` and `await` it — the hooks are async and require the async runtime:

```python
# WRONG — hooks may not fire
result = Runner.run_sync(agent, "...")

# CORRECT
result = await Runner.run(agent, "...")
```

### `ImportError: cannot import name 'AgentHooks' from 'agents'`

Update the OpenAI Agents SDK:

```bash
pip install --upgrade openai-agents
```

If `DeciGraphAgentHooks` is imported but `AgentHooks` is unavailable, the module defines stub classes and will log a warning:

```python
from decigraph_openai_agents.hooks import _AGENTS_SDK_AVAILABLE
print(_AGENTS_SDK_AVAILABLE)  # False if SDK not installed
```

In this case, install the SDK or use the integration in an environment where it is available.

### Tool outputs not captured

Ensure `capture_tool_outputs=True` (the default) and that your tools are registered via the SDK's `@function_tool` decorator or `FunctionTool` class — not raw Python callables.

Verify the `on_tool_output` hook fires by subclassing:

```python
class DebugHooks(DeciGraphAgentHooks):
    async def on_tool_output(self, context, agent, tool, result):
        print(f"[DEBUG] Tool output: {str(result)[:100]}")
        await super().on_tool_output(context, agent, tool, result)
```

### High latency on first run

The first `compile_context` call for a new agent involves:
1. Generating an embedding for the task description (OpenAI API call)
2. HNSW nearest-neighbor search in PostgreSQL
3. BFS graph expansion
4. Token budget allocation

Subsequent calls for the same `(agent_name, task_description)` are cached for 1 hour. If the first call is consistently slow (> 2s), check the HNSW index:

```bash
docker compose exec postgres psql -U decigraph -d decigraph -c "\d decisions"
# Look for: "embedding_hnsw_cosine_idx" btree (embedding vector_cosine_ops)
```

If the index is missing, run migrations:

```bash
docker compose exec server pnpm db:migrate
```
