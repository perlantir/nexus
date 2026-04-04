# CrewAI Integration Guide

The `decigraph-crewai` package gives CrewAI agents persistent, shared decision memory backed by DeciGraph. Task outputs are automatically extracted by the distillery pipeline, so every agent in the crew benefits from decisions made by every other agent — across sessions.

---

## Table of Contents

- [How It Works](#how-it-works)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [DeciGraphCrewMemory](#decigraphcrewmemory)
  - [Constructor Parameters](#constructor-parameters)
  - [The `save()` Method](#the-save-method)
  - [The `search()` Method](#the-search-method)
  - [Batched Distillation](#batched-distillation)
- [DeciGraphCrewCallback](#decigraphcrewcallback)
  - [Constructor Parameters](#constructor-parameters-1)
  - [Task Lifecycle Hooks](#task-lifecycle-hooks)
  - [Crew Lifecycle Hooks](#crew-lifecycle-hooks)
- [Complete Example: Research Crew](#complete-example-research-crew)
- [Multi-Agent Crew with Role-Based Context](#multi-agent-crew-with-role-based-context)
- [Recording Decisions Manually](#recording-decisions-manually)
- [Configuration Reference](#configuration-reference)
- [Best Practices](#best-practices)
- [Troubleshooting](#troubleshooting)

---

## How It Works

```
CrewAI Task completes
       │
       ▼
DeciGraphCrewCallback.on_task_complete(task, output)
       │
       ├──► DeciGraph Distillery  ──► Extracts decisions from task output
       │                     ──► Stores in PostgreSQL
       │
       ▼
Next Task: agent.search("What did we decide about X?")
       │
       ▼
DeciGraphCrewMemory.search(query)
       │
       ▼
DeciGraph compile_context  ──► 5-signal scoring ──► Ranked decisions
       │
       ▼
Returns [(context_blob, score=1.0), (decision1, score), ...]
```

Each agent in your crew gets memory scoped to its role. When agent B asks "what architectural decisions have been made?", DeciGraph returns decisions sorted by relevance to B's role and task — including decisions made by agent A in a previous session.

---

## Installation

```bash
pip install decigraph-sdk decigraph-crewai crewai
```

Or install from the repository:

```bash
cd /path/to/decigraph/integrations/crewai
pip install -e .
```

**Supported versions:**
- Python 3.10+
- CrewAI 0.28+
- decigraph-sdk 0.1+

---

## Quick Start

```python
from decigraph_sdk import DeciGraphClient
from decigraph_crewai import DeciGraphCrewMemory, DeciGraphCrewCallback
from crewai import Agent, Task, Crew, Process

# 1. Initialize DeciGraph
client = DeciGraphClient(base_url="http://localhost:3100")
PROJECT_ID = "proj_01hx..."

# 2. Create memory backend for each agent
researcher_memory = DeciGraphCrewMemory(
    client=client,
    project_id=PROJECT_ID,
    agent_name="researcher",
)

writer_memory = DeciGraphCrewMemory(
    client=client,
    project_id=PROJECT_ID,
    agent_name="writer",
)

# 3. Create callback for automatic extraction
callback = DeciGraphCrewCallback(
    client=client,
    project_id=PROJECT_ID,
    agent_name="crew",
)

# 4. Define agents
researcher = Agent(
    role="Research Analyst",
    goal="Find and analyze information about the given topic",
    backstory="You are an expert researcher with deep analytical skills.",
    verbose=True,
)

writer = Agent(
    role="Technical Writer",
    goal="Transform research findings into clear documentation",
    backstory="You write clear, accurate technical content.",
    verbose=True,
)

# 5. Attach memory backends
researcher._memory_handler = researcher_memory
writer._memory_handler = writer_memory

# 6. Define tasks
research_task = Task(
    description="Research the current state of vector databases. Focus on pgvector vs Pinecone vs Weaviate.",
    expected_output="A comprehensive comparison with pros/cons and a recommendation.",
    agent=researcher,
)

writing_task = Task(
    description="Write a technical blog post based on the research findings.",
    expected_output="A 1000-word blog post in markdown format.",
    agent=writer,
    context=[research_task],
)

# 7. Create and run the crew
crew = Crew(
    agents=[researcher, writer],
    tasks=[research_task, writing_task],
    process=Process.sequential,
    task_callback=callback.on_task_complete,
    step_callback=callback.on_step,
    verbose=True,
)

result = crew.kickoff()

# 8. Finalize — creates a session summary in DeciGraph
callback.on_crew_complete(crew_output=result, crew=crew)
```

---

## DeciGraphCrewMemory

`DeciGraphCrewMemory` implements the CrewAI memory backend interface. Attach it to an agent to give that agent access to DeciGraph-backed recall.

### Constructor Parameters

```python
DeciGraphCrewMemory(
    client: DeciGraphClient,
    project_id: str,
    agent_name: str,
    default_task_description: str = "Perform the current crew task.",
    max_tokens: int | None = None,
    distill_on_save: bool = True,
)
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `client` | `DeciGraphClient` | required | Initialized DeciGraph client |
| `project_id` | `str` | required | DeciGraph project ID |
| `agent_name` | `str` | required | Agent name for context scoping and attribution |
| `default_task_description` | `str` | `"Perform the current crew task."` | Fallback task description for `search()` calls |
| `max_tokens` | `int \| None` | `None` | Token budget for context compilation |
| `distill_on_save` | `bool` | `True` | Send to distillery immediately on `save()` |

### The `save()` Method

CrewAI calls `save()` after each task to persist the output:

```python
memory.save(
    value="We decided to use PostgreSQL with pgvector instead of Pinecone due to cost constraints.",
    metadata={"task_id": "task-001", "tool": "research"},
    agent="researcher",  # optional override
)
```

When `distill_on_save=True` (default), the text is immediately sent to the DeciGraph distillery. The distillery uses an LLM to extract structured decisions, which are stored with embeddings in the decision graph.

When `distill_on_save=False`, saves are buffered and must be flushed manually:

```python
memory = DeciGraphCrewMemory(client=client, project_id=PROJECT_ID, agent_name="researcher", distill_on_save=False)

# ... crew runs ...

# Flush all buffered saves at once (single API call)
memory.flush()
```

### The `search()` Method

CrewAI calls `search()` when an agent needs to recall information:

```python
results = memory.search(
    query="What database technology was selected?",
    task_description="Write documentation for the data layer.",  # optional
)

# results is a list of dicts:
# [
#   {"type": "context", "text": "<compiled context blob>", "score": 1.0},
#   {"type": "decision", "decision_id": "dec_01hx...", "text": "Use pgvector: ...", "score": 0.87},
#   ...
# ]
```

The first element is always the full compiled context text. Subsequent elements are individual decisions ranked by their relevance score.

### Batched Distillation

For long-running crews with many tasks, batching reduces API calls:

```python
memory = DeciGraphCrewMemory(
    client=client,
    project_id=PROJECT_ID,
    agent_name="researcher",
    distill_on_save=False,  # buffer saves
)

# Attach to agent
researcher._memory_handler = memory

# Run the crew...

# At the end, flush everything in one distillery call
memory.flush()
```

### Resetting the Buffer

```python
# Discard buffered (not-yet-distilled) content without sending to DeciGraph
memory.reset()
```

---

## DeciGraphCrewCallback

`DeciGraphCrewCallback` hooks into CrewAI's callback system to automatically capture task outputs and create session summaries.

### Constructor Parameters

```python
DeciGraphCrewCallback(
    client: DeciGraphClient,
    project_id: str,
    agent_name: str = "crew",
    create_session_on_crew_end: bool = True,
)
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `client` | `DeciGraphClient` | required | Initialized DeciGraph client |
| `project_id` | `str` | required | DeciGraph project ID |
| `agent_name` | `str` | `"crew"` | Default agent name for session summaries |
| `create_session_on_crew_end` | `bool` | `True` | Create a `SessionSummary` when `on_crew_complete()` is called |

### Task Lifecycle Hooks

#### `on_task_complete(task, output)`

Call this (or pass it as `task_callback`) for each completed task:

```python
crew = Crew(
    agents=[...],
    tasks=[...],
    task_callback=callback.on_task_complete,
)
```

CrewAI passes the `Task` object and its `TaskOutput`. The callback:

1. Extracts the output text (handles `str`, `TaskOutput.raw`, `TaskOutput.result`, etc.)
2. Formats it as `"Task: {description}\n\nOutput:\n{text}"`
3. Sends it to the DeciGraph distillery
4. Accumulates extracted decision IDs for the final session summary

#### `on_step(step)`

Pass as `step_callback` to hook into individual agent steps. The default implementation is a no-op — override or subclass to capture intermediate reasoning:

```python
class MyCallback(DeciGraphCrewCallback):
    def on_step(self, step):
        print(f"Agent step: {step}")
        super().on_step(step)

callback = MyCallback(client=client, project_id=PROJECT_ID)
crew = Crew(..., step_callback=callback.on_step)
```

### Crew Lifecycle Hooks

#### `on_crew_complete(crew_output, crew)`

Call this after `crew.kickoff()` returns:

```python
result = crew.kickoff()
callback.on_crew_complete(crew_output=result, crew=crew)
```

This:
1. Builds a session summary including task count and the final output preview
2. Creates a `SessionSummary` in DeciGraph linking all decisions extracted during the run
3. Resets the callback's internal state for potential re-use

If `create_session_on_crew_end=False`, only the reset happens.

#### Using the Callback as a Callable

`DeciGraphCrewCallback` is directly callable, so it can be passed to CrewAI's `task_callback` without `.on_task_complete`:

```python
crew = Crew(
    task_callback=callback,  # __call__ delegates to on_task_complete
)
```

---

## Complete Example: Research Crew

A full end-to-end example with persistent memory across runs:

```python
import os
from decigraph_sdk import DeciGraphClient
from decigraph_crewai import DeciGraphCrewMemory, DeciGraphCrewCallback
from crewai import Agent, Task, Crew, Process
from crewai.tools import tool
from langchain_openai import ChatOpenAI

# Initialize
client = DeciGraphClient(base_url=os.environ["DECIGRAPH_API_URL"])
PROJECT_ID = os.environ["DECIGRAPH_PROJECT_ID"]
llm = ChatOpenAI(model="gpt-4o", temperature=0.1)

# Create memories (one per agent role)
memories = {
    "architect": DeciGraphCrewMemory(
        client=client,
        project_id=PROJECT_ID,
        agent_name="architect",
        default_task_description="Design the system architecture.",
        max_tokens=4096,
    ),
    "security": DeciGraphCrewMemory(
        client=client,
        project_id=PROJECT_ID,
        agent_name="security",
        default_task_description="Review security implications.",
        max_tokens=4096,
    ),
    "reviewer": DeciGraphCrewMemory(
        client=client,
        project_id=PROJECT_ID,
        agent_name="reviewer",
        default_task_description="Review all decisions for consistency.",
        max_tokens=4096,
    ),
}

# Callback for automatic session capture
callback = DeciGraphCrewCallback(
    client=client,
    project_id=PROJECT_ID,
    agent_name="architecture-crew",
    create_session_on_crew_end=True,
)

# Agents
architect = Agent(
    role="Software Architect",
    goal="Design scalable, maintainable system architecture",
    backstory=(
        "You are a senior software architect with 15 years of experience. "
        "You always consider the existing project decisions before making new ones."
    ),
    llm=llm,
    verbose=True,
)

security_reviewer = Agent(
    role="Security Engineer",
    goal="Identify and address security vulnerabilities in architectural decisions",
    backstory=(
        "You are a security engineer who reviews all architectural decisions "
        "for security implications and compliance requirements."
    ),
    llm=llm,
    verbose=True,
)

tech_reviewer = Agent(
    role="Technical Reviewer",
    goal="Ensure all decisions are consistent, documented, and aligned with project goals",
    backstory=(
        "You perform final technical review, ensuring consistency across decisions "
        "and flagging any contradictions or gaps."
    ),
    llm=llm,
    verbose=True,
)

# Attach memories
architect._memory_handler = memories["architect"]
security_reviewer._memory_handler = memories["security"]
tech_reviewer._memory_handler = memories["reviewer"]

# Tasks
architecture_task = Task(
    description=(
        "Design the authentication system for the DeciGraph API. "
        "Consider: token types (JWT vs API keys), expiry policies, "
        "refresh mechanisms, and integration with existing auth providers. "
        "Document your decisions clearly with rationale."
    ),
    expected_output=(
        "An architectural decision record (ADR) with: "
        "the chosen approach, alternatives considered, rationale, "
        "and implementation notes."
    ),
    agent=architect,
)

security_task = Task(
    description=(
        "Review the authentication architecture decisions from the previous task. "
        "Identify any security risks, recommend mitigations, and verify compliance "
        "with OWASP API Security Top 10."
    ),
    expected_output=(
        "A security review report with: risk assessment, "
        "recommended mitigations, and a go/no-go recommendation."
    ),
    agent=security_reviewer,
    context=[architecture_task],
)

review_task = Task(
    description=(
        "Perform a final review of all architectural and security decisions. "
        "Check for contradictions, gaps, and missing documentation. "
        "Produce a summary of all decisions made."
    ),
    expected_output=(
        "A decision summary document listing all decisions, "
        "their status (confirmed/needs-revision), and any action items."
    ),
    agent=tech_reviewer,
    context=[architecture_task, security_task],
)

# Crew
crew = Crew(
    agents=[architect, security_reviewer, tech_reviewer],
    tasks=[architecture_task, security_task, review_task],
    process=Process.sequential,
    task_callback=callback.on_task_complete,
    verbose=True,
)

# Run
print("Starting architecture review crew...")
result = crew.kickoff()

# Finalize — creates a SessionSummary in DeciGraph
callback.on_crew_complete(crew_output=result, crew=crew)

print("\n=== Crew Complete ===")
print(f"Final output:\n{result}")
print("\nDecisions have been captured in DeciGraph and are available for future crews.")
```

---

## Multi-Agent Crew with Role-Based Context

DeciGraph has 16 built-in role templates. When your agent name matches a role (e.g., `"architect"`, `"security"`, `"reviewer"`), DeciGraph automatically applies higher relevance scoring for decisions tagged with that role.

```python
from decigraph_sdk import DeciGraphClient
from decigraph_crewai import DeciGraphCrewMemory

client = DeciGraphClient(base_url="http://localhost:3100")

# These names map to DeciGraph built-in roles — agents automatically
# get higher relevance scores for decisions affecting their role
ROLE_AGENTS = [
    "architect",    # architectural decisions
    "builder",      # implementation decisions
    "reviewer",     # review/quality decisions
    "security",     # security decisions
    "qa",           # testing decisions
    "devops",       # deployment decisions
]

memories = {
    role: DeciGraphCrewMemory(
        client=client,
        project_id="proj_01hx...",
        agent_name=role,
        max_tokens=3000,
    )
    for role in ROLE_AGENTS
}
```

To see the full list of built-in roles and their tag weights:

```bash
curl http://localhost:3100/api/projects/proj_01hx.../agents \
  | jq '.[].profile.tags'
```

---

## Recording Decisions Manually

For critical decisions, bypass the distillery and record them directly with full metadata:

```python
from decigraph_sdk import DeciGraphClient

client = DeciGraphClient(base_url="http://localhost:3100")

# Record a specific decision with full metadata
decision = client.record_decision(
    project_id="proj_01hx...",
    title="Use JWT with 15-minute expiry",
    description=(
        "All API authentication will use JWT tokens with a 15-minute expiry "
        "and a 7-day refresh token. Refresh tokens are stored in httpOnly cookies."
    ),
    rationale=(
        "Short JWT expiry limits the window for token theft. "
        "httpOnly cookies prevent XSS attacks from accessing refresh tokens."
    ),
    tags=["authentication", "security", "api"],
    affects=["builder", "security", "qa"],
    confidence=0.95,
    status="active",
)

print(f"Decision recorded: {decision['id']}")
```

---

## Configuration Reference

### DeciGraphClient Options

```python
client = DeciGraphClient(
    base_url="http://localhost:3100",  # DeciGraph API URL
    api_key="nxk_...",                 # optional API key
    timeout=30,                        # request timeout in seconds
)
```

### Environment Variables

If you prefer environment-based configuration:

```bash
export DECIGRAPH_API_URL=http://localhost:3100
export DECIGRAPH_PROJECT_ID=proj_01hx...
export DECIGRAPH_API_KEY=nxk_...
```

Then instantiate without arguments:

```python
import os
from decigraph_sdk import DeciGraphClient

client = DeciGraphClient(
    base_url=os.environ["DECIGRAPH_API_URL"],
    api_key=os.environ.get("DECIGRAPH_API_KEY"),
)
```

---

## Best Practices

**One memory instance per agent role.** Don't share a single `DeciGraphCrewMemory` across multiple agents — each agent should have its own instance with its own `agent_name`. This ensures context is compiled with the correct role-based weighting.

**Use `distill_on_save=False` for large crews.** If you have 10+ tasks producing long outputs, batching reduces API latency and cost. Call `memory.flush()` at the end.

**Set `default_task_description` accurately.** This description is used when `search()` is called without an explicit task context. The more specific it is, the better DeciGraph can rank relevant context.

**Name agents to match DeciGraph roles.** Using `agent_name="architect"`, `"security"`, `"qa"`, etc. activates the built-in role templates and improves context relevance automatically.

**Always call `on_crew_complete()`.** Without this call, no session summary is created in DeciGraph, and the crew run will not appear in the dashboard or contribute to cross-session context.

**Check for contradictions before long runs.** If your crew is about to make architectural decisions, fetch current contradictions first:

```python
from decigraph_sdk import DeciGraphClient

client = DeciGraphClient(base_url="http://localhost:3100")
contradictions = client.get_contradictions(project_id="proj_01hx...")
if contradictions:
    print(f"Warning: {len(contradictions)} contradictions found. Resolve before running crew.")
    for c in contradictions:
        print(f"  - {c['decision_a']['title']} ↔ {c['decision_b']['title']}")
```

---

## Troubleshooting

### Memory search returns empty results

Ensure the DeciGraph server is running and has decisions stored:

```bash
curl http://localhost:3100/api/projects/proj_01hx.../decisions | jq length
```

If decisions exist but search returns empty, check that embeddings are generated:

```bash
curl "http://localhost:3100/api/projects/proj_01hx.../decisions?limit=1" | jq '.[0].embedding_generated'
```

### Distillery not extracting decisions

The distillery uses an LLM (Anthropic by default). Verify your API key:

```bash
echo $ANTHROPIC_API_KEY
```

Test directly:

```bash
curl -X POST http://localhost:3100/api/projects/proj_01hx.../distill \
  -H "Content-Type: application/json" \
  -d '{"conversation_text": "We decided to use Redis for caching."}'
```

### `AttributeError: _memory_handler`

Some versions of CrewAI use different attribute names for custom memory. Check your CrewAI version:

```python
import crewai; print(crewai.__version__)
```

For CrewAI ≥ 0.41, use the custom memory API directly:

```python
from crewai.memory.storage.interface import Storage

class DeciGraphStorage(Storage):
    def __init__(self, decigraph_memory):
        self._mem = decigraph_memory

    def save(self, value, metadata=None, **kwargs):
        self._mem.save(value, metadata=metadata)

    def search(self, query, limit=None, **kwargs):
        return self._mem.search(query)

agent = Agent(
    role="Researcher",
    memory=True,
    # CrewAI >= 0.41 accepts a custom storage backend
)
```

### ImportError: decigraph_crewai not found

Install from the repository:

```bash
cd /path/to/decigraph/integrations/crewai
pip install -e .
```

Or ensure you are using the correct virtual environment:

```bash
which python
pip show decigraph-crewai
```
