# AutoGen Integration Guide

The `decigraph-autogen` package integrates DeciGraph decision memory into Microsoft AutoGen agents. It provides `DeciGraphAutoGenMemory`, which injects compiled project context into agent system messages, buffers conversation messages for automatic decision extraction, and creates session summaries when a conversation ends.

---

## Table of Contents

- [How It Works](#how-it-works)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [DeciGraphAutoGenMemory Reference](#decigraphautogenmemory-reference)
  - [Constructor Parameters](#constructor-parameters)
  - [`get_context()`](#get_context)
  - [`get_relevant_decisions()`](#get_relevant_decisions)
  - [`store_message()`](#store_message)
  - [`store_messages_batch()`](#store_messages_batch)
  - [`flush_to_distillery()`](#flush_to_distillery)
  - [`on_session_end()`](#on_session_end)
  - [`transform_messages_hook()`](#transform_messages_hook)
- [AutoGen v0.4 — TransformMessages Hook](#autogen-v04--transformmessages-hook)
- [AutoGen v0.2/v0.3 — ConversableAgent Pattern](#autogen-v02v03--conversableagent-pattern)
- [Complete Example: Two-Agent Conversation](#complete-example-two-agent-conversation)
- [Complete Example: GroupChat with Shared Memory](#complete-example-groupchat-with-shared-memory)
- [Complete Example: Sequential Agent Pipeline](#complete-example-sequential-agent-pipeline)
- [Recording Decisions Manually](#recording-decisions-manually)
- [Cross-Session Memory](#cross-session-memory)
- [Configuration Reference](#configuration-reference)
- [Best Practices](#best-practices)
- [Troubleshooting](#troubleshooting)

---

## How It Works

```
AutoGen Agent conversation starts
         │
         ▼
decigraph_mem.get_context()           — compile_context (5-signal scoring)
         │
         ▼
Prepend [DeciGraph Context] to system message
         │
         ▼
Agent conversation runs
         │
    (each message) ──► decigraph_mem.store_message(role, content)
         │                    └── auto-flush every N messages
         │
         ▼
decigraph_mem.on_session_end()
         │
    ├── flush_to_distillery()   — LLM extracts decisions
    └── create_session_summary() — links all extracted decisions
```

The memory object is attached at the Python level — there is no modification to AutoGen internals. You call `get_context()` once at setup and `store_message()` / `on_session_end()` as the conversation progresses.

---

## Installation

```bash
pip install decigraph-sdk decigraph-autogen pyautogen
```

For AutoGen v0.4+:

```bash
pip install decigraph-sdk decigraph-autogen autogen-agentchat
```

Or install from the repository:

```bash
cd /path/to/decigraph/integrations/autogen
pip install -e .
```

**Supported versions:**
- Python 3.10+
- AutoGen 0.2.x, 0.3.x (ConversableAgent)
- AutoGen 0.4+ (agentchat, TransformMessages)
- decigraph-sdk 0.1+

---

## Quick Start

```python
import os
import autogen
from decigraph_sdk import DeciGraphClient
from decigraph_autogen import DeciGraphAutoGenMemory

# Initialize
client = DeciGraphClient(base_url=os.environ["DECIGRAPH_API_URL"])
PROJECT_ID = os.environ["DECIGRAPH_PROJECT_ID"]

# Create memory for the assistant agent
decigraph_mem = DeciGraphAutoGenMemory(
    client=client,
    project_id=PROJECT_ID,
    agent_name="assistant",
    task_description="Implement the payments module.",
    distill_every=10,
)

# Get DeciGraph context to inject into the system message
decigraph_context = decigraph_mem.get_context()

# Create AutoGen agents with DeciGraph context
assistant = autogen.AssistantAgent(
    name="assistant",
    system_message=f"""{decigraph_context}

You are a helpful software engineer. When you make implementation decisions,
state them clearly with rationale.""",
    llm_config={"model": "gpt-4o", "api_key": os.environ["OPENAI_API_KEY"]},
)

user_proxy = autogen.UserProxyAgent(
    name="user_proxy",
    human_input_mode="TERMINATE",
    max_consecutive_auto_reply=5,
)

# Register a reply hook to capture messages for DeciGraph
original_receive = assistant.receive

def tracked_receive(message, sender, **kwargs):
    content = message if isinstance(message, str) else message.get("content", "")
    decigraph_mem.store_message(role="user", content=content, name=sender.name)
    return original_receive(message, sender, **kwargs)

assistant.receive = tracked_receive

# Run the conversation
user_proxy.initiate_chat(
    assistant,
    message="How should we handle payment retries and idempotency?",
)

# Capture the assistant's final message
for msg in assistant.chat_messages.get(user_proxy, []):
    if msg.get("role") == "assistant":
        decigraph_mem.store_message(role="assistant", content=msg["content"])

# Finalize — flushes remaining messages and creates a SessionSummary
decigraph_mem.on_session_end(
    summary="Discussed payment retry and idempotency strategy."
)
```

---

## DeciGraphAutoGenMemory Reference

### Constructor Parameters

```python
DeciGraphAutoGenMemory(
    client: DeciGraphClient,
    project_id: str,
    agent_name: str,
    task_description: str = "Perform the current task.",
    max_tokens: int | None = None,
    distill_every: int = 10,
    create_session_on_end: bool = True,
)
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `client` | `DeciGraphClient` | required | Initialized DeciGraph client |
| `project_id` | `str` | required | DeciGraph project ID |
| `agent_name` | `str` | required | Agent name for context scoping and attribution |
| `task_description` | `str` | `"Perform the current task."` | Used for context compilation and session summaries |
| `max_tokens` | `int \| None` | `None` | Token budget for context compilation |
| `distill_every` | `int` | `10` | Auto-flush to distillery after this many stored messages (0 = manual only) |
| `create_session_on_end` | `bool` | `True` | Create a `SessionSummary` in DeciGraph on `on_session_end()` |

### `get_context()`

Compiles and returns relevant DeciGraph context as a plain string. Call once at the start of a session to populate the system message.

```python
context_text: str = decigraph_mem.get_context(
    task_description="Implement the payments module.",  # optional override
)

# Use in system message
system = f"[DeciGraph Context]\n{context_text}\n\nYou are a helpful engineer."
```

Returns an empty string if DeciGraph is unreachable (fails gracefully).

### `get_relevant_decisions()`

Returns a list of decision dicts ranked by relevance to a query:

```python
decisions: list[dict] = decigraph_mem.get_relevant_decisions(
    query="What database technology did we select?",  # optional, defaults to task_description
)

for dec in decisions:
    print(f"[{dec['confidence']:.0%}] {dec['title']}: {dec['description'][:100]}")
```

### `store_message()`

Buffer a single message for later distillation:

```python
decigraph_mem.store_message(
    role="user",       # "user" | "assistant" | "system" | "tool" | "function"
    content="We should use idempotency keys for all payment operations.",
    name="user_proxy",  # optional sender name
)
```

When the buffer reaches `distill_every` messages, it is automatically flushed to the distillery.

### `store_messages_batch()`

Store multiple messages at once from AutoGen's native message format:

```python
# AutoGen stores conversation history as a list of dicts
messages = assistant.chat_messages.get(user_proxy, [])
decigraph_mem.store_messages_batch(messages)
```

Each dict must have at least `"role"` and `"content"` keys. The optional `"name"` field is also read.

### `flush_to_distillery()`

Manually send all buffered messages to the distillery:

```python
decigraph_mem.flush_to_distillery()
```

Use this when `distill_every=0` or when you want to checkpoint mid-conversation.

### `on_session_end()`

Finalize the session: flushes remaining messages and optionally creates a `SessionSummary`:

```python
session = decigraph_mem.on_session_end(
    summary="Designed payment retry strategy with exponential backoff.",  # optional
    additional_decision_ids=["dec_01hx...", "dec_02hx..."],               # optional
)

# session is the created SessionSummary dict, or None on error
if session:
    print(f"Session saved: {session['id']}")
```

After `on_session_end()`, the memory object resets its internal state and can be reused for another session.

### `transform_messages_hook()`

An AutoGen v0.4 `TransformMessages`-compatible hook. Prepends compiled DeciGraph context as a system message to every LLM call:

```python
hook = decigraph_mem.transform_messages_hook

# Use directly as a transform
transformed = hook(messages)
```

Or pass to `TransformMessages`:

```python
from autogen.agentchat.contrib.capabilities.transform_messages import TransformMessages

transform = TransformMessages(
    transforms=[decigraph_mem.transform_messages_hook]
)
```

The hook:
1. Calls `get_context()` to compile relevant decisions
2. Prepends `{"role": "system", "content": "[DeciGraph Context]\n{context}"}` if not already present
3. Returns the (possibly augmented) message list unchanged if DeciGraph is unreachable

---

## AutoGen v0.4 — TransformMessages Hook

AutoGen v0.4 introduces the `TransformMessages` capability for modifying message lists before LLM calls. `DeciGraphAutoGenMemory.transform_messages_hook` is designed for this API.

```python
import asyncio
import os
from autogen_agentchat.agents import AssistantAgent
from autogen_agentchat.teams import RoundRobinGroupChat
from autogen_agentchat.ui import Console
from autogen_ext.models.openai import OpenAIChatCompletionClient
from decigraph_sdk import DeciGraphClient
from decigraph_autogen import DeciGraphAutoGenMemory

client = DeciGraphClient(base_url=os.environ["DECIGRAPH_API_URL"])
PROJECT_ID = os.environ["DECIGRAPH_PROJECT_ID"]

# Memory instances for each agent
arch_memory = DeciGraphAutoGenMemory(
    client=client,
    project_id=PROJECT_ID,
    agent_name="architect",
    task_description="Design the API gateway architecture.",
    distill_every=8,
)

sec_memory = DeciGraphAutoGenMemory(
    client=client,
    project_id=PROJECT_ID,
    agent_name="security",
    task_description="Review security implications of architectural decisions.",
    distill_every=8,
)

# Create model client
model_client = OpenAIChatCompletionClient(
    model="gpt-4o",
    api_key=os.environ["OPENAI_API_KEY"],
)

# Create agents with transform_messages hooks
architect = AssistantAgent(
    name="architect",
    model_client=model_client,
    system_message="You are a software architect. Design scalable solutions.",
    # Use the transform hook to inject DeciGraph context
    model_context=None,  # let the transform handle context
)

# Manually apply the transform hook by wrapping the agent's model calls
# (The exact API depends on your AutoGen v0.4 version)

async def run_with_decigraph():
    team = RoundRobinGroupChat(
        participants=[architect],
        max_turns=4,
    )

    # Stream the conversation
    async for msg in team.run_stream(task="Design an API gateway for microservices."):
        # Capture messages for DeciGraph
        if hasattr(msg, "content") and hasattr(msg, "source"):
            memory_for = arch_memory if msg.source == "architect" else sec_memory
            memory_for.store_message(
                role="assistant",
                content=msg.content,
                name=msg.source,
            )
        print(msg)

    # Finalize both agents' sessions
    arch_memory.on_session_end(summary="Designed API gateway architecture.")
    sec_memory.on_session_end(summary="Reviewed API gateway security.")

asyncio.run(run_with_decigraph())
```

### Direct Hook Usage (Any Version)

The `transform_messages_hook` works independently of the AutoGen version:

```python
import openai
from decigraph_sdk import DeciGraphClient
from decigraph_autogen import DeciGraphAutoGenMemory

client = DeciGraphClient(base_url="http://localhost:3100")
decigraph_mem = DeciGraphAutoGenMemory(
    client=client,
    project_id="proj_01hx...",
    agent_name="assistant",
    task_description="Help design the system.",
)

# Any message list destined for an LLM
messages = [
    {"role": "user", "content": "What caching strategy should we use?"}
]

# Inject DeciGraph context
augmented_messages = decigraph_mem.transform_messages_hook(messages)
# augmented_messages[0] is now a system message with DeciGraph context
# augmented_messages[1] is the original user message

# Send to OpenAI (or any LLM)
openai_client = openai.OpenAI()
response = openai_client.chat.completions.create(
    model="gpt-4o",
    messages=augmented_messages,
)

# Store the exchange
decigraph_mem.store_message(role="user", content=messages[0]["content"])
decigraph_mem.store_message(role="assistant", content=response.choices[0].message.content)
```

---

## AutoGen v0.2/v0.3 — ConversableAgent Pattern

For AutoGen v0.2/v0.3, use the `ConversableAgent` reply hooks to capture messages:

```python
import os
import autogen
from decigraph_sdk import DeciGraphClient
from decigraph_autogen import DeciGraphAutoGenMemory

client = DeciGraphClient(base_url=os.environ["DECIGRAPH_API_URL"])
PROJECT_ID = os.environ["DECIGRAPH_PROJECT_ID"]

decigraph_mem = DeciGraphAutoGenMemory(
    client=client,
    project_id=PROJECT_ID,
    agent_name="assistant",
    task_description="Implement the data pipeline.",
    distill_every=5,
)

# Get context before starting
context = decigraph_mem.get_context()

assistant = autogen.AssistantAgent(
    name="assistant",
    system_message=f"[DeciGraph Context]\n{context}\n\nYou are a data engineer.",
    llm_config={"model": "gpt-4o"},
)

user_proxy = autogen.UserProxyAgent(
    name="user_proxy",
    human_input_mode="NEVER",
    max_consecutive_auto_reply=3,
    code_execution_config=False,
)

# Hook: capture each message AutoGen processes
def capture_message_hook(recipient, messages, sender, config):
    """Called by AutoGen when a message is delivered."""
    if messages:
        last_msg = messages[-1]
        role = last_msg.get("role", "user")
        content = last_msg.get("content", "")
        name = last_msg.get("name", sender.name if sender else "unknown")
        if content:
            decigraph_mem.store_message(role=role, content=content, name=name)
    return False, None  # Don't intercept — just observe

assistant.register_reply(
    trigger=autogen.Agent,
    reply_func=capture_message_hook,
    position=0,  # Run before the default reply
)

# Run the conversation
user_proxy.initiate_chat(
    assistant,
    message="Design a fault-tolerant data pipeline for real-time event processing.",
)

# Finalize
decigraph_mem.on_session_end(
    summary=f"Designed data pipeline architecture: {user_proxy.last_message(assistant)['content'][:200]}"
)
```

---

## Complete Example: Two-Agent Conversation

```python
import os
import autogen
from decigraph_sdk import DeciGraphClient
from decigraph_autogen import DeciGraphAutoGenMemory

client = DeciGraphClient(base_url=os.environ["DECIGRAPH_API_URL"])
PROJECT_ID = os.environ["DECIGRAPH_PROJECT_ID"]

# Create memories for both agents
architect_mem = DeciGraphAutoGenMemory(
    client=client,
    project_id=PROJECT_ID,
    agent_name="architect",
    task_description="Design authentication and authorization architecture.",
    max_tokens=6000,
    distill_every=6,
)

reviewer_mem = DeciGraphAutoGenMemory(
    client=client,
    project_id=PROJECT_ID,
    agent_name="reviewer",
    task_description="Review architectural decisions for consistency and security.",
    max_tokens=6000,
    distill_every=6,
)

# Get context for each agent
arch_context = architect_mem.get_context()
reviewer_context = reviewer_mem.get_context()

# Optionally check for contradictions before starting
decisions = architect_mem.get_relevant_decisions(
    query="authentication authorization API security"
)
if decisions:
    print(f"Found {len(decisions)} relevant existing decisions:")
    for d in decisions[:3]:
        print(f"  [{d.get('status', 'active')}] {d['title']}")

# Create agents
architect = autogen.AssistantAgent(
    name="architect",
    system_message=f"""[DeciGraph Context — Existing Decisions]
{arch_context}

You are a software architect specializing in authentication systems.
When proposing a decision, state clearly:
- What you are deciding
- Why (rationale)
- What alternatives you considered""",
    llm_config={"model": "gpt-4o", "temperature": 0.1},
)

reviewer = autogen.AssistantAgent(
    name="reviewer",
    system_message=f"""[DeciGraph Context — Existing Decisions]
{reviewer_context}

You are a technical reviewer. Your job is to:
1. Identify gaps or risks in proposed decisions
2. Flag contradictions with existing decisions
3. Ask clarifying questions
4. Confirm when a decision is sound""",
    llm_config={"model": "gpt-4o", "temperature": 0.1},
)

user_proxy = autogen.UserProxyAgent(
    name="user_proxy",
    human_input_mode="NEVER",
    max_consecutive_auto_reply=1,
    code_execution_config=False,
    is_termination_msg=lambda x: "REVIEW COMPLETE" in x.get("content", ""),
)

# Capture replies for DeciGraph
def make_capture_hook(memory: DeciGraphAutoGenMemory, agent_name: str):
    def hook(recipient, messages, sender, config):
        if messages:
            msg = messages[-1]
            content = msg.get("content", "")
            if content:
                memory.store_message(
                    role=msg.get("role", "assistant"),
                    content=content,
                    name=msg.get("name", agent_name),
                )
        return False, None
    return hook

architect.register_reply(autogen.Agent, make_capture_hook(architect_mem, "architect"), position=0)
reviewer.register_reply(autogen.Agent, make_capture_hook(reviewer_mem, "reviewer"), position=0)

# Initiate the design conversation
print("Starting architect-reviewer conversation...")
user_proxy.initiate_chat(
    architect,
    message=(
        "We need to decide on the authentication strategy for the new API. "
        "Consider: API keys vs JWT vs OAuth2. We have mobile clients and server-to-server integrations."
    ),
    max_turns=4,
)

print("\nHanding off to reviewer...")
user_proxy.initiate_chat(
    reviewer,
    message=f"Please review the architect's proposed authentication design: {architect.last_message(user_proxy)['content'][:500]}",
    max_turns=2,
)

# Finalize both sessions
print("\nFinalizing sessions...")
arch_session = architect_mem.on_session_end(
    summary="Authentication architecture discussion: API keys for server-to-server, JWT for clients."
)
rev_session = reviewer_mem.on_session_end(
    summary="Technical review of authentication architecture proposal."
)

print(f"Architect session: {arch_session['id'] if arch_session else 'none'}")
print(f"Reviewer session: {rev_session['id'] if rev_session else 'none'}")
print("All decisions captured in DeciGraph.")
```

---

## Complete Example: GroupChat with Shared Memory

```python
import os
import autogen
from decigraph_sdk import DeciGraphClient
from decigraph_autogen import DeciGraphAutoGenMemory

client = DeciGraphClient(base_url=os.environ["DECIGRAPH_API_URL"])
PROJECT_ID = os.environ["DECIGRAPH_PROJECT_ID"]

# Each participant gets its own memory object
ROLES = ["architect", "security", "devops", "qa"]
memories = {
    role: DeciGraphAutoGenMemory(
        client=client,
        project_id=PROJECT_ID,
        agent_name=role,
        task_description="Team design session: microservices deployment strategy.",
        max_tokens=4096,
        distill_every=8,
    )
    for role in ROLES
}

# Get context for each role
contexts = {role: mem.get_context() for role, mem in memories.items()}

# Create agents
agents = {
    role: autogen.AssistantAgent(
        name=role,
        system_message=f"[DeciGraph Context]\n{contexts[role]}\n\nYou are the {role} specialist.",
        llm_config={"model": "gpt-4o"},
    )
    for role in ROLES
}

user_proxy = autogen.UserProxyAgent(
    name="moderator",
    human_input_mode="NEVER",
    max_consecutive_auto_reply=0,
    code_execution_config=False,
)

# GroupChat
groupchat = autogen.GroupChat(
    agents=list(agents.values()) + [user_proxy],
    messages=[],
    max_round=12,
    speaker_selection_method="auto",
)

manager = autogen.GroupChatManager(
    groupchat=groupchat,
    llm_config={"model": "gpt-4o"},
)

# Run the group conversation
user_proxy.initiate_chat(
    manager,
    message="Let's decide on our Kubernetes deployment strategy. Each specialist should contribute.",
)

# After the chat, extract all messages per role and store in DeciGraph
for message in groupchat.messages:
    speaker_name = message.get("name", "")
    content = message.get("content", "")
    role_match = next((r for r in ROLES if r == speaker_name), None)
    if role_match and content:
        memories[role_match].store_message(
            role="assistant",
            content=content,
            name=speaker_name,
        )

# Finalize all sessions
for role, mem in memories.items():
    session = mem.on_session_end()
    if session:
        print(f"{role} session saved: {session['id']}")
```

---

## Recording Decisions Manually

For high-confidence decisions, bypass the distillery and record directly:

```python
from decigraph_sdk import DeciGraphClient

client = DeciGraphClient(base_url="http://localhost:3100")

decision = client.record_decision(
    project_id="proj_01hx...",
    title="Use Kubernetes with Helm for deployment",
    description=(
        "All production services will be deployed to Kubernetes using Helm charts. "
        "GitOps workflow via ArgoCD. Blue-green deployments for zero-downtime updates."
    ),
    rationale=(
        "Kubernetes provides the scalability and self-healing we need. "
        "Helm charts allow reproducible deployments. "
        "The team has existing Kubernetes expertise."
    ),
    tags=["deployment", "kubernetes", "infrastructure"],
    affects=["devops", "builder", "ops"],
    confidence=0.92,
)

print(f"Decision recorded: {decision['id']}")
```

---

## Cross-Session Memory

DeciGraph decisions persist across Python processes. Start a new session and all previous decisions are available:

```python
# Session 1 — Monday
mem = DeciGraphAutoGenMemory(client=client, project_id=PROJECT_ID, agent_name="architect", ...)
context = mem.get_context()
# context includes all decisions from previous sessions

# ... conversation runs, decisions extracted ...
mem.on_session_end(summary="Monday architecture session.")

# ----- New process, Tuesday -----

# Session 2 — Tuesday
mem2 = DeciGraphAutoGenMemory(client=client, project_id=PROJECT_ID, agent_name="architect", ...)
context2 = mem2.get_context()
# context2 includes decisions from Monday's session AND all earlier sessions
```

This works because all decisions are stored in PostgreSQL with embeddings. The 5-signal scoring algorithm ranks them by relevance to the current task, not by recency alone.

---

## Configuration Reference

### DeciGraphClient Options

```python
DeciGraphClient(
    base_url="http://localhost:3100",
    api_key="nxk_...",  # optional
    timeout=30,
)
```

### Environment Variables

```bash
DECIGRAPH_API_URL=http://localhost:3100
DECIGRAPH_PROJECT_ID=proj_01hx...
DECIGRAPH_API_KEY=nxk_...
```

---

## Best Practices

**Create one `DeciGraphAutoGenMemory` per agent, not one per conversation.** Each memory instance has its own buffer and tracks decisions for a specific agent role. Sharing a single instance across multiple agents conflates their contributions.

**Set `distill_every` based on message volume.** For long GroupChats (50+ messages), use a higher value (20–30) to batch API calls. For short conversations (< 10 messages), use 5 or lower so decisions are captured even if `on_session_end()` is not called.

**Always call `on_session_end()`.** Without it, buffered messages are not sent to the distillery and no `SessionSummary` is created. The session's decisions will be invisible to future agents.

**Use `get_relevant_decisions()` before starting.** This lets you warn the team if conflicting decisions already exist and surfaces relevant prior decisions in a structured format for conditional logic.

**Name agents to match DeciGraph built-in roles.** Agent names like `"architect"`, `"security"`, `"devops"`, `"qa"` activate role-based weighting in DeciGraph's scoring algorithm, improving context relevance.

**Handle unreachable DeciGraph gracefully.** All `DeciGraphAutoGenMemory` methods catch `DeciGraphError` and log warnings rather than raising. Your AutoGen code will continue working even if DeciGraph is temporarily unavailable.

---

## Troubleshooting

### `get_context()` returns an empty string

The DeciGraph server may be unreachable, or the project has no decisions yet. Verify:

```bash
curl http://localhost:3100/health
curl http://localhost:3100/api/projects/proj_01hx.../decisions | jq length
```

If the project is new, add at least one decision before expecting context:

```bash
curl -X POST http://localhost:3100/api/projects/proj_01hx.../decisions \
  -H "Content-Type: application/json" \
  -d '{"title": "Use Python 3.12", "description": "All services use Python 3.12.", "tags": ["language"]}'
```

### Distillery not extracting decisions

Check the `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY` if using OpenAI as distillery provider):

```bash
curl -X POST http://localhost:3100/api/projects/proj_01hx.../distill \
  -H "Content-Type: application/json" \
  -d '{"conversation_text": "We decided to use Redis for session storage."}'
```

If this returns an error, check server logs:

```bash
docker compose logs server | tail -50
# or
journalctl -u decigraph-server -n 50
```

### `on_session_end()` returns `None`

A `None` return value means the session summary creation failed. Enable debug logging to see the error:

```python
import logging
logging.basicConfig(level=logging.DEBUG)
```

Then look for `DeciGraphAutoGenMemory.on_session_end: ...` in the output.

### Messages not accumulating (buffer stays at 0)

If `store_message()` is not being called, check your hook registration. AutoGen's callback API changed between versions:

```python
# v0.2/v0.3 — use register_reply
agent.register_reply(autogen.Agent, hook_fn, position=0)

# v0.4 — use model_context or message transforms
```

Verify messages are being stored:

```python
# Inspect the buffer size
print(f"Buffered messages: {len(decigraph_mem._messages)}")
```

### `ImportError: No module named 'decigraph_autogen'`

Install from the repository:

```bash
cd /path/to/decigraph/integrations/autogen
pip install -e .
```

Verify the install:

```bash
python -c "from decigraph_autogen import DeciGraphAutoGenMemory; print('OK')"
```
