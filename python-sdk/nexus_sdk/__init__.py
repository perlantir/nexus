"""
nexus-sdk
=========
Official Python SDK for the DeciGraph multi-agent memory and decision platform.

Quick start::

    from nexus_sdk import DeciGraphClient

    client = DeciGraphClient(base_url="http://localhost:3100", api_key="my-key")

    project = client.create_project("My Project")
    decision = client.create_decision(
        project_id=project["id"],
        title="Use PostgreSQL",
        description="Primary data store will be PostgreSQL.",
        reasoning="Team expertise and excellent JSONB support.",
        made_by="architect-agent",
    )
    context = client.compile_context(
        project_id=project["id"],
        agent_name="coder-agent",
        task_description="Implement the user authentication service.",
    )
"""

from .client import DeciGraphClient
from .exceptions import (
    DeciGraphApiError,
    DeciGraphAuthError,
    DeciGraphConnectionError,
    DeciGraphError,
    DeciGraphNotFoundError,
    DeciGraphValidationError,
)
from .types import (
    Agent,
    Artifact,
    ContextPackage,
    Contradiction,
    Decision,
    DecisionEdge,
    DistilleryResult,
    FeedbackRecord,
    GraphResult,
    ImpactAnalysis,
    Notification,
    Project,
    SessionSummary,
    Subscription,
)

__version__ = "0.1.0"

__all__ = [
    # Client
    "DeciGraphClient",
    # Exceptions
    "DeciGraphError",
    "DeciGraphApiError",
    "DeciGraphNotFoundError",
    "DeciGraphAuthError",
    "DeciGraphValidationError",
    "DeciGraphConnectionError",
    # Types
    "Project",
    "Agent",
    "Decision",
    "DecisionEdge",
    "GraphResult",
    "Artifact",
    "SessionSummary",
    "Notification",
    "Subscription",
    "Contradiction",
    "ContextPackage",
    "DistilleryResult",
    "ImpactAnalysis",
    "FeedbackRecord",
]
