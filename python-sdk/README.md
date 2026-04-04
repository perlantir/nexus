# nexus-sdk

Official Python SDK for the [DeciGraph](https://github.com/nexus-platform/nexus) multi-agent memory and decision platform.

## Installation

```bash
pip install nexus-sdk
```

Or for local development:

```bash
cd python-sdk
pip install -e ".[dev]"
```

## Quick Start

```python
from nexus_sdk import DeciGraphClient

client = DeciGraphClient(base_url="http://localhost:3100", api_key="my-key")

# Create a project
project = client.create_project("My Project", "A demonstration project")

# Register an agent
agent = client.create_agent(
    project_id=project["id"],
    name="architect-agent",
    role="architect",
    capabilities=["design", "review"],
)

# Record a decision
decision = client.create_decision(
    project_id=project["id"],
    title="Use PostgreSQL",
    description="All persistent data will be stored in PostgreSQL.",
    reasoning="Team expertise and strong JSONB support.",
    made_by="architect-agent",
    tags=["database", "infrastructure"],
)

# Compile context for another agent
context = client.compile_context(
    project_id=project["id"],
    agent_name="coder-agent",
    task_description="Implement user authentication service.",
    max_tokens=4096,
)
print(context["compiled_text"])

# Send a conversation to the distillery
result = client.distill(
    project_id=project["id"],
    conversation_text="...<full chat log>...",
    agent_name="coder-agent",
)
print(f"Extracted {len(result['decisions_created'])} decisions")
```

## API Reference

See the inline docstrings in `nexus_sdk/client.py` for the full API surface.
